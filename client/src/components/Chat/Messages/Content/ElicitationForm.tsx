import { useState } from 'react';
import { dataService } from 'librechat-data-provider';
import { Button, Input, Label } from '@librechat/client';
import type { Agents } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { useLocalize } from '~/hooks';
import cn from '~/utils/cn';

type ElicitationAction = Agents.ElicitationAction;

type ElicitationField = {
  key: string;
  schema: Agents.ElicitationPropertySchema;
};

type FieldValue = string | number | boolean;

function getDefaultValues(
  properties: Record<string, Agents.ElicitationPropertySchema>,
): Record<string, FieldValue> {
  const defaults: Record<string, FieldValue> = {};
  for (const [key, schema] of Object.entries(properties)) {
    if (schema.default != null) {
      defaults[key] = schema.default;
    } else if (schema.type === 'boolean') {
      defaults[key] = false;
    } else {
      defaults[key] = '';
    }
  }
  return defaults;
}

function getStatusText(
  resolvedAction: ElicitationAction,
  localize: (key: TranslationKeys) => string,
): string {
  if (resolvedAction === 'accept') {
    return localize('com_ui_elicitation_completed');
  }
  if (resolvedAction === 'complete') {
    return localize('com_ui_elicitation_authorized');
  }
  if (resolvedAction === 'cancel') {
    return localize('com_ui_elicitation_cancelled');
  }
  return localize('com_ui_elicitation_declined');
}

/**
 * Renders an in-chat card for MCP elicitation. Covers both wire mechanisms:
 * - `mode: 'form'` — a 2025-06-18 `elicitation/create` request; renders the
 *   requested JSON-schema fields and posts `accept`/`decline`.
 * - `mode: 'url'` — either a `mode: 'url'` `elicitation/create` request, or the
 *   -32042 URL-exception path on `tools/call`; renders a message, a prominent
 *   authorization link, and Continue/Cancel. Continue posts `action:
 *   'complete'`, which resumes/retries the suspended tool call server-side.
 *
 * Both modes resolve via the same `POST /api/mcp/elicitation/:flowId` route
 * (`dataService.respondToElicitation`), mirroring the OAuth "visit a URL, then
 * get resumed" flow already used elsewhere in MCP tool calls.
 */
export default function ElicitationForm({
  flowId,
  mode,
  message,
  url,
  requestedSchema,
  action: initialAction,
}: Agents.ElicitationContent['elicitation']) {
  const localize = useLocalize();
  const isUrlMode = mode === 'url';
  const properties = requestedSchema?.properties ?? {};
  const [values, setValues] = useState<Record<string, FieldValue>>(() =>
    getDefaultValues(properties),
  );
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [resolvedAction, setResolvedAction] = useState<ElicitationAction | undefined>(
    initialAction,
  );

  const fields: ElicitationField[] = Object.entries(properties).map(([key, schema]) => ({
    key,
    schema,
  }));

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    for (const { key, schema } of fields) {
      const required = requestedSchema?.required?.includes(key) ?? false;
      const val = values[key];
      if (required && (val === '' || val == null)) {
        newErrors[key] = `${schema.title ?? key} is required`;
      }
      if (schema.type === 'string' && typeof val === 'string') {
        if (schema.minLength != null && val.length < schema.minLength) {
          newErrors[key] = `Minimum length is ${schema.minLength}`;
        }
        if (schema.maxLength != null && val.length > schema.maxLength) {
          newErrors[key] = `Maximum length is ${schema.maxLength}`;
        }
      }
      if ((schema.type === 'number' || schema.type === 'integer') && val !== '') {
        const num = Number(val);
        if (schema.minimum != null && num < schema.minimum) {
          newErrors[key] = `Minimum value is ${schema.minimum}`;
        }
        if (schema.maximum != null && num > schema.maximum) {
          newErrors[key] = `Maximum value is ${schema.maximum}`;
        }
      }
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const submitAction = async (action: ElicitationAction) => {
    if (action === 'accept' && !isUrlMode && !validate()) {
      return;
    }
    setSubmitting(true);
    try {
      const content =
        action === 'accept' && !isUrlMode
          ? Object.fromEntries(
              fields.map(({ key, schema }) => {
                const val = values[key];
                if (schema.type === 'number' || schema.type === 'integer') {
                  return [key, Number(val)];
                }
                return [key, val];
              }),
            )
          : undefined;
      await dataService.respondToElicitation(flowId, { action, content });
      setResolvedAction(action);
    } catch {
      // Server-side flow will time out on its own; leave the card interactive
      // so the user can retry the click.
    } finally {
      setSubmitting(false);
    }
  };

  const requiredMark = (key: string) =>
    requestedSchema?.required?.includes(key) ? <span className="ml-1 text-red-500">*</span> : null;

  const renderField = ({ key, schema }: ElicitationField) => {
    const label = schema.title ?? key;
    const fieldId = `elicitation-${flowId}-${key}`;
    const error = errors[key];

    if (schema.enum) {
      return (
        <div key={key} className="flex flex-col gap-1">
          <Label htmlFor={fieldId} className="text-sm font-medium text-text-primary">
            {label}
            {requiredMark(key)}
          </Label>
          {schema.description && (
            <p className="text-xs text-text-secondary">{schema.description}</p>
          )}
          <select
            id={fieldId}
            value={String(values[key] ?? '')}
            onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
            disabled={submitting}
            className="rounded-lg border border-border-light bg-surface-primary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-ring-primary"
          >
            <option value="">{localize('com_ui_select')}</option>
            {schema.enum.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
      );
    }

    if (schema.type === 'boolean') {
      return (
        <div key={key} className="flex items-center gap-2">
          <input
            id={fieldId}
            type="checkbox"
            checked={Boolean(values[key])}
            onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.checked }))}
            disabled={submitting}
            className="h-4 w-4 rounded border-border-light accent-ring-primary"
          />
          <Label htmlFor={fieldId} className="text-sm text-text-primary">
            {label}
            {requiredMark(key)}
          </Label>
          {schema.description && (
            <p className="text-xs text-text-secondary">{schema.description}</p>
          )}
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
      );
    }

    return (
      <div key={key} className="flex flex-col gap-1">
        <Label htmlFor={fieldId} className="text-sm font-medium text-text-primary">
          {label}
          {requiredMark(key)}
        </Label>
        {schema.description && <p className="text-xs text-text-secondary">{schema.description}</p>}
        <Input
          id={fieldId}
          type={schema.type === 'number' || schema.type === 'integer' ? 'number' : 'text'}
          value={String(values[key] ?? '')}
          onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
          disabled={submitting}
          min={schema.minimum}
          max={schema.maximum}
          minLength={schema.minLength}
          maxLength={schema.maxLength}
          className={cn(error && 'border-red-500 focus-visible:ring-red-500')}
        />
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>
    );
  };

  if (resolvedAction) {
    return (
      <div className="my-2 rounded-xl border border-border-light bg-surface-secondary p-4">
        <p className="text-sm text-text-secondary">{getStatusText(resolvedAction, localize)}</p>
      </div>
    );
  }

  if (isUrlMode) {
    return (
      <div className="my-2 rounded-xl border border-border-light bg-surface-secondary p-4 shadow-md">
        <p className="mb-4 text-sm text-text-primary">{message}</p>
        <div className="mb-4">
          <Button asChild variant="submit" size="sm">
            <a href={url} target="_blank" rel="noopener noreferrer">
              {localize('com_ui_elicitation_open_url')}
            </a>
          </Button>
        </div>
        <div className="flex gap-2">
          <Button
            variant="default"
            size="sm"
            disabled={submitting}
            onClick={() => submitAction('complete')}
          >
            {localize('com_ui_elicitation_continue')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={submitting}
            onClick={() => submitAction('cancel')}
          >
            {localize('com_ui_elicitation_cancel')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-xl border border-border-light bg-surface-secondary p-4 shadow-md">
      <p className="mb-4 text-sm text-text-primary">{message}</p>
      <div className="flex flex-col gap-3">{fields.map((field) => renderField(field))}</div>
      <div className="mt-4 flex gap-2">
        <Button
          variant="default"
          size="sm"
          disabled={submitting}
          onClick={() => submitAction('accept')}
        >
          {localize('com_ui_elicitation_submit')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={submitting}
          onClick={() => submitAction('decline')}
        >
          {localize('com_ui_elicitation_decline')}
        </Button>
      </div>
    </div>
  );
}
