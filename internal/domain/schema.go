package domain

import (
	"bytes"
	"cmp"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/santhosh-tekuri/jsonschema/v6/kind"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
)

// SchemaProblem is one reason a schema or an instance is refused. Pointer is a
// JSON pointer into the document, "" for the root.
type SchemaProblem struct {
	Pointer string `json:"pointer"`
	Message string `json:"message"`
}

const metaschemaURL = "https://json-schema.org/draft/2020-12/schema"

var (
	namespacePattern = regexp.MustCompile(`^~?[a-z0-9][a-z0-9._@+-]{0,127}$`)
	namePattern      = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,127}$`)
	pointerEscaper   = strings.NewReplacer("~", "~0", "/", "~1")

	metaOnce   sync.Once
	metaSchema *jsonschema.Schema
	metaErr    error
)

// CheckSchema is R08: an object, no other $schema, valid against the 2020-12 metaschema.
func CheckSchema(bodyText string) []SchemaProblem {
	doc, err := jsonschema.UnmarshalJSON(strings.NewReader(bodyText))
	if err != nil {
		return []SchemaProblem{{Message: "is not valid JSON: " + err.Error()}}
	}
	obj, ok := doc.(map[string]any)
	if !ok {
		return []SchemaProblem{{Message: "must be a JSON object"}}
	}
	var problems []SchemaProblem
	if d, has := obj["$schema"]; has && d != metaschemaURL {
		problems = append(problems, SchemaProblem{Pointer: "/$schema", Message: "must be " + metaschemaURL})
	}
	metaOnce.Do(func() {
		metaSchema, metaErr = jsonschema.NewCompiler().Compile(metaschemaURL)
	})
	if metaErr != nil {
		return append(problems, SchemaProblem{Message: "metaschema unavailable: " + metaErr.Error()})
	}
	if err := metaSchema.Validate(doc); err != nil {
		problems = append(problems, validationProblems(err)...)
	}
	sortProblems(problems)
	return problems
}

// SchemaRefs lists the lde:// versions that bodyText refers to, and problems for
// any $id, and for any $ref or $dynamicRef that is neither a local fragment nor
// a registry URL. A string under those keys counts wherever it appears.
func SchemaRefs(bodyText string) (refs []string, problems []SchemaProblem) {
	doc, err := jsonschema.UnmarshalJSON(strings.NewReader(bodyText))
	if err != nil {
		return nil, []SchemaProblem{{Message: "is not valid JSON: " + err.Error()}}
	}
	seen := map[string]bool{}
	var walk func(v any, ptr string)
	walk = func(v any, ptr string) {
		switch t := v.(type) {
		case map[string]any:
			for k, val := range t {
				s, isString := val.(string)
				if !isString || (k != "$id" && k != "$ref" && k != "$dynamicRef") {
					walk(val, childPointer(ptr, k))
					continue
				}
				if k == "$id" {
					problems = append(problems, SchemaProblem{Pointer: ptr, Message: "$id is not allowed"})
					continue
				}
				if strings.HasPrefix(s, "#") {
					continue
				}
				u, _, _ := strings.Cut(s, "#")
				if _, _, _, _, ok := ParseSchemaURL(u); !ok {
					problems = append(problems, SchemaProblem{Pointer: ptr, Message: fmt.Sprintf("%s %q is not a local fragment or a registry URL", k, s)})
					continue
				}
				if !seen[u] {
					seen[u] = true
					refs = append(refs, u)
				}
			}
		case []any:
			for i, val := range t {
				walk(val, childPointer(ptr, strconv.Itoa(i)))
			}
		}
	}
	walk(doc, "")
	slices.Sort(refs)
	sortProblems(problems)
	return refs, problems
}

// registryLoader serves only lde:// URLs, so a $ref can't read the disk or the network.
type registryLoader func(url string) (string, error)

func (f registryLoader) Load(url string) (any, error) {
	if !strings.HasPrefix(url, "lde://") {
		return nil, fmt.Errorf("%s is not a registry URL", url)
	}
	text, err := f(url)
	if err != nil {
		return nil, err
	}
	return jsonschema.UnmarshalJSON(strings.NewReader(text))
}

// CompileSchema compiles for validation. load returns a registry version's text.
func CompileSchema(url, bodyText string, load func(url string) (string, error)) (*jsonschema.Schema, error) {
	doc, err := jsonschema.UnmarshalJSON(strings.NewReader(bodyText))
	if err != nil {
		return nil, err
	}
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	c.AssertFormat()
	c.UseLoader(registryLoader(load))
	if err := c.AddResource(url, doc); err != nil {
		return nil, err
	}
	return c.Compile(url)
}

// ValidateInstance returns one problem per failed rule, sorted by pointer, then message.
func ValidateInstance(s *jsonschema.Schema, instance []byte) []SchemaProblem {
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(instance))
	if err != nil {
		return []SchemaProblem{{Message: "is not valid JSON: " + err.Error()}}
	}
	if err := s.Validate(doc); err != nil {
		problems := validationProblems(err)
		sortProblems(problems)
		return problems
	}
	return nil
}

// BundleSchema returns one self-contained document for the form. Each lde://
// version the body reaches, transitively, goes into the root $defs under the
// key "lde:<ns>:<name>:<major>.<minor>". Every $ref to it becomes a local
// pointer ("#/$defs/<key>" plus its fragment, escaped per RFC 6901), and the
// local refs inside an embedded document gain that prefix. A ref load can't
// find (a draft's) is left as it is.
func BundleSchema(bodyText string, load func(url string) (string, error)) (map[string]any, error) {
	doc, err := jsonschema.UnmarshalJSON(strings.NewReader(bodyText))
	if err != nil {
		return nil, err
	}
	root, ok := doc.(map[string]any)
	if !ok {
		return nil, errors.New("schema is not a JSON object")
	}
	defs, _ := root["$defs"].(map[string]any)
	if defs == nil {
		defs = map[string]any{}
		root["$defs"] = defs
	}
	b := &bundler{load: load, defs: defs}
	if err := b.rewrite(root, ""); err != nil {
		return nil, err
	}
	return root, nil
}

// ParseSchemaName parses "ns/name@major.minor". The namespace may contain '@',
// so the version is split off at the last one.
func ParseSchemaName(s string) (ns, name string, major, minor int, ok bool) {
	i := strings.LastIndex(s, "@")
	if i < 0 {
		return "", "", 0, 0, false
	}
	return parseParts(s[:i], s[i+1:])
}

// ParseSchemaURL parses lde://schemas/<ns>/<name>/<major>.<minor>.
func ParseSchemaURL(s string) (ns, name string, major, minor int, ok bool) {
	rest, found := strings.CutPrefix(s, "lde://schemas/")
	i := strings.LastIndex(rest, "/")
	if !found || i < 0 {
		return "", "", 0, 0, false
	}
	return parseParts(rest[:i], rest[i+1:])
}

// SchemaURL is the registry URL of a schema version.
func SchemaURL(ns, name string, major, minor int) string {
	return fmt.Sprintf("lde://schemas/%s/%s/%d.%d", ns, name, major, minor)
}

// parseParts parses "ns/name" and "major.minor".
func parseParts(nsName, ver string) (ns, name string, major, minor int, ok bool) {
	ns, name, ok = splitName(nsName)
	if !ok {
		return "", "", 0, 0, false
	}
	major, minor, ok = parseVersion(ver)
	if !ok {
		return "", "", 0, 0, false
	}
	return ns, name, major, minor, true
}

// splitName splits "ns/name" on its only '/' and checks both parts.
func splitName(s string) (ns, name string, ok bool) {
	ns, name, found := strings.Cut(s, "/")
	if !found || !namespacePattern.MatchString(ns) || !namePattern.MatchString(name) {
		return "", "", false
	}
	return ns, name, true
}

// parseVersion parses "major.minor" with plain non-negative integers.
func parseVersion(s string) (major, minor int, ok bool) {
	maj, min, found := strings.Cut(s, ".")
	major, okMajor := parseUint(maj)
	minor, okMinor := parseUint(min)
	return major, minor, found && okMajor && okMinor
}

func parseUint(s string) (int, bool) {
	if s == "" {
		return 0, false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, false
		}
	}
	n, err := strconv.Atoi(s)
	return n, err == nil
}

// bundler copies registry versions into defs. Each key is in defs once it is
// being bundled, which also stops cycles.
type bundler struct {
	load func(url string) (string, error)
	defs map[string]any
}

// rewrite points the $ref values in v at their $defs entries. key is the entry
// v sits in, or "" for the root, where local refs stay as they are.
func (b *bundler) rewrite(v any, key string) error {
	switch t := v.(type) {
	case map[string]any:
		for k, val := range t {
			if s, ok := val.(string); ok && (k == "$ref" || k == "$dynamicRef") {
				ref, err := b.ref(s, key)
				if err != nil {
					return err
				}
				t[k] = ref
				continue
			}
			if err := b.rewrite(val, key); err != nil {
				return err
			}
		}
	case []any:
		for _, val := range t {
			if err := b.rewrite(val, key); err != nil {
				return err
			}
		}
	}
	return nil
}

// ref returns the local form of one $ref found in the entry key ("" for the root).
func (b *bundler) ref(s, key string) (string, error) {
	if strings.HasPrefix(s, "#") {
		if key == "" {
			return s, nil
		}
		return "#/$defs/" + key + s[1:], nil
	}
	u, frag, _ := strings.Cut(s, "#")
	k, ok, err := b.embed(u)
	if err != nil {
		return "", err
	}
	if !ok {
		return s, nil
	}
	return "#/$defs/" + k + frag, nil
}

// embed puts the registry version at url into defs and returns its key. ok is
// false when url isn't a registry URL or can't be loaded.
func (b *bundler) embed(url string) (key string, ok bool, err error) {
	ns, name, major, minor, valid := ParseSchemaURL(url)
	if !valid {
		return "", false, nil
	}
	key = fmt.Sprintf("lde:%s:%s:%d.%d", ns, name, major, minor)
	if _, done := b.defs[key]; done {
		return key, true, nil
	}
	text, err := b.load(url)
	if err != nil {
		return "", false, nil
	}
	doc, err := jsonschema.UnmarshalJSON(strings.NewReader(text))
	if err != nil {
		return "", false, err
	}
	b.defs[key] = doc
	return key, true, b.rewrite(doc, key)
}

// validationProblems flattens a validation error to its leaf causes. Required
// and additionalProperties become one problem per name, at that name.
func validationProblems(err error) []SchemaProblem {
	var ve *jsonschema.ValidationError
	if !errors.As(err, &ve) {
		return []SchemaProblem{{Message: err.Error()}}
	}
	var out []SchemaProblem
	p := message.NewPrinter(language.English)
	var walk func(e *jsonschema.ValidationError)
	walk = func(e *jsonschema.ValidationError) {
		if len(e.Causes) > 0 {
			for _, c := range e.Causes {
				walk(c)
			}
			return
		}
		parent := ""
		for _, seg := range e.InstanceLocation {
			parent = childPointer(parent, seg)
		}
		switch k := e.ErrorKind.(type) {
		case *kind.Required:
			for _, name := range k.Missing {
				out = append(out, SchemaProblem{Pointer: childPointer(parent, name), Message: "is required"})
			}
		case *kind.AdditionalProperties:
			for _, name := range k.Properties {
				out = append(out, SchemaProblem{Pointer: childPointer(parent, name), Message: "is not allowed"})
			}
		default:
			out = append(out, SchemaProblem{Pointer: parent, Message: e.ErrorKind.LocalizedString(p)})
		}
	}
	walk(ve)
	return out
}

func childPointer(parent, seg string) string {
	return parent + "/" + pointerEscaper.Replace(seg)
}

func sortProblems(problems []SchemaProblem) {
	slices.SortFunc(problems, func(a, b SchemaProblem) int {
		return cmp.Or(strings.Compare(a.Pointer, b.Pointer), strings.Compare(a.Message, b.Message))
	})
}
