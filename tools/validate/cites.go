package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// e2ePackage is the package name of Playwright citations and results.
const e2ePackage = "web/e2e"

// citation is one requirement ID cited by one top-level test.
type citation struct {
	ID, Package, Test, File string
}

var specRef = regexp.MustCompile(`SPEC-\d{3}-R\d{2}`)

// scanTests finds every SPEC-NNN-RNN cited by a top-level Test function in the
// *_test.go files under root. module is the module path of root.
func scanTests(root, module string) ([]citation, error) {
	var cites []citation
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			name := d.Name()
			if path != root && (strings.HasPrefix(name, ".") || strings.HasPrefix(name, "_") ||
				name == "testdata" || name == "vendor") {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, "_test.go") {
			return nil
		}
		found, err := scanFile(root, path, module)
		if err != nil {
			return err
		}
		cites = append(cites, found...)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return cites, nil
}

// scanFile returns the citations made by the top-level Test functions in one file.
func scanFile(root, path, module string) ([]citation, error) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
	if err != nil {
		return nil, err
	}
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return nil, err
	}
	file := filepath.ToSlash(rel)
	pkg := module
	if dir := filepath.ToSlash(filepath.Dir(rel)); dir != "." {
		pkg = module + "/" + dir
	}

	var cites []citation
	for _, decl := range f.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body == nil || !strings.HasPrefix(fn.Name.Name, "Test") {
			continue
		}
		var groups []*ast.CommentGroup
		if fn.Doc != nil {
			groups = append(groups, fn.Doc)
		}
		for _, cg := range f.Comments {
			if cg.Pos() >= fn.Body.Pos() && cg.End() <= fn.Body.End() {
				groups = append(groups, cg)
			}
		}
		seen := map[string]bool{}
		for _, cg := range groups {
			for _, c := range cg.List {
				for _, id := range specRef.FindAllString(c.Text, -1) {
					if seen[id] {
						continue
					}
					seen[id] = true
					cites = append(cites, citation{ID: id, Package: pkg, Test: fn.Name.Name, File: file})
				}
			}
		}
	}
	return cites, nil
}

// e2eTitle matches the start of a Playwright test: test('title', ...).
var e2eTitle = regexp.MustCompile(`^\s*test\(\s*(?:'([^']*)'|"([^"]*)")`)

// scanE2E finds every SPEC-NNN-RNN cited on the line above test( in the
// web/e2e/*.spec.ts files under root. The citation's package is web/e2e and
// its test is the test title.
func scanE2E(root string) ([]citation, error) {
	files, err := filepath.Glob(filepath.Join(root, "web", "e2e", "*.spec.ts"))
	if err != nil {
		return nil, err
	}
	var cites []citation
	for _, path := range files {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		lines := strings.Split(string(data), "\n")
		for i := 1; i < len(lines); i++ {
			m := e2eTitle.FindStringSubmatch(lines[i])
			above := strings.TrimSpace(lines[i-1])
			if m == nil || !strings.HasPrefix(above, "//") {
				continue
			}
			title := m[1] + m[2]
			seen := map[string]bool{}
			for _, id := range specRef.FindAllString(above, -1) {
				if seen[id] {
					continue
				}
				seen[id] = true
				cites = append(cites, citation{ID: id, Package: e2ePackage, Test: title, File: "web/e2e/" + filepath.Base(path)})
			}
		}
	}
	return cites, nil
}
