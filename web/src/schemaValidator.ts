// Adapters between the Go server's JSON Schema rules and rjsf (SPEC-009-R09).
// The server is the only source of validation errors a scientist sees; the
// client-side validator only answers rjsf's questions about which fields to draw.
import { Validator } from '@cfworker/json-schema';
import type { ErrorSchema, RJSFSchema, UiSchema, ValidatorType } from '@rjsf/utils';
import type { SchemaProblem } from './api';

// withRoot lets a sub-schema resolve "#/$defs/..." refs against the root schema.
function withRoot(schema: RJSFSchema, rootSchema?: RJSFSchema): RJSFSchema {
  if (!rootSchema || rootSchema === schema) return schema;
  return { ...schema, $defs: rootSchema.$defs, definitions: rootSchema.definitions };
}

function rawValidation<Result = any>(schema: RJSFSchema, formData?: any): { errors?: Result[]; validationError?: Error } {
  try {
    const result = new Validator(schema as any, '2020-12').validate(formData);
    return { errors: result.errors as Result[] };
  } catch (e) {
    return { errors: [], validationError: e as Error };
  }
}

// schemaValidator reports no errors from validateFormData: errors come from the server.
export const schemaValidator: ValidatorType = {
  validateFormData: () => ({ errors: [], errorSchema: {} }),
  isValid: (schema, formData, rootSchema) => {
    try {
      return new Validator(withRoot(schema, rootSchema) as any, '2020-12').validate(formData).valid;
    } catch {
      return false;
    }
  },
  rawValidation,
};

// uiSchemaFor maps the x-lde-* keywords onto rjsf's uiSchema.
export function uiSchemaFor(schema: RJSFSchema): UiSchema {
  const ui: UiSchema = {};
  const s = schema as Record<string, any>;
  const widget = s['x-lde-widget'];
  if (widget === 'textarea' || widget === 'date') ui['ui:widget'] = widget;

  if (s.properties && typeof s.properties === 'object') {
    for (const [name, sub] of Object.entries<any>(s.properties)) {
      const child = uiSchemaFor(sub);
      if (typeof sub?.['x-lde-unit'] === 'string') {
        child['ui:title'] = `${sub.title ?? name} (${sub['x-lde-unit']})`;
      }
      if (Object.keys(child).length > 0) ui[name] = child;
    }
    if (Array.isArray(s['x-lde-order'])) ui['ui:order'] = [...s['x-lde-order'], '*'];
  }
  if (s.items && typeof s.items === 'object' && !Array.isArray(s.items)) {
    const items = uiSchemaFor(s.items);
    if (typeof s.items['x-lde-unit'] === 'string') {
      items['ui:title'] = `${s.items.title ?? ''} (${s.items['x-lde-unit']})`.trim();
    }
    if (Object.keys(items).length > 0) ui.items = items;
  }
  return ui;
}

// toErrorSchema turns server problems into rjsf's extraErrors shape.
export function toErrorSchema(problems: SchemaProblem[]): ErrorSchema {
  const root: Record<string, any> = {};
  for (const p of problems) {
    let node = root;
    if (p.pointer !== '') {
      for (const raw of p.pointer.replace(/^\//, '').split('/')) {
        const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
        node = node[key] ??= {};
      }
    }
    (node.__errors ??= []).push(p.message);
  }
  return root as ErrorSchema;
}
