import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';

type ControlProps = { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean };

// Field gives a control a visible label, an optional hint, and an error below it,
// all wired with aria-describedby (SPEC-025 design §3.2). The child is one
// input, select or textarea; Field sets its id.
export default function Field({
  label,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactElement<ControlProps>;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const control = isValidElement(children)
    ? cloneElement(children, { id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })
    : children;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {control}
      {hint && (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field-error" id={errorId}>
          {error}
        </p>
      )}
    </div>
  );
}
