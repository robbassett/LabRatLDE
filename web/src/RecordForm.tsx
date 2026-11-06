import Form from '@rjsf/core';
import type { RJSFSchema } from '@rjsf/utils';
import type { SchemaProblem } from './api';
import { schemaValidator, toErrorSchema, uiSchemaFor } from './schemaValidator';

// RecordForm draws a schema as a form. The problems come from the server (useSchemaValidation or a 422).
// With warnOnly they are listed as a warning instead of marking the fields.
export default function RecordForm({
  schema,
  value,
  onChange,
  problems,
  readOnly,
  warnOnly,
}: {
  schema: RJSFSchema;
  value: unknown;
  onChange: (value: unknown) => void;
  problems: SchemaProblem[];
  readOnly?: boolean;
  warnOnly?: boolean;
}) {
  return (
    <div className="record-form">
      <Form
        schema={schema}
        formData={value}
        validator={schemaValidator}
        uiSchema={uiSchemaFor(schema)}
        extraErrors={warnOnly ? undefined : toErrorSchema(problems)}
        liveValidate={false}
        noHtml5Validate
        readonly={readOnly}
        onChange={(e) => onChange(e.formData)}
      >
        <></>
      </Form>
      {warnOnly && problems.length > 0 && (
        <div className="record-form-warning">
          <p className="muted">Not checked until the run starts</p>
          <ul>
            {problems.map((p, i) => (
              <li key={i}>
                {p.pointer !== '' && <code>{p.pointer}</code>} {p.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
