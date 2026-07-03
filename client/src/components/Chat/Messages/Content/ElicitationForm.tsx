import { useState } from 'react';
import type { ReactNode } from 'react';
import { dataService } from 'librechat-data-provider';
import { Button, Input, Label, Spinner } from '@librechat/client';
import {
  ShieldCheck,
  ClipboardList,
  ExternalLink,
  RotateCw,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
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

/** Header chrome shared by both modes: a tinted circular icon, a title, and the
 *  requesting server/tool identity. Keeps the card visually native to LibreChat's
 *  other in-chat system cards (see `ToolCall` OAuth sign-in). */
function CardHeader({
  icon,
  title,
  identity,
}: {
  icon: ReactNode;
  title: string;
  identity?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-tertiary text-text-secondary">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-primary">{title}</p>
        {identity && <p className="truncate text-xs text-text-secondary">{identity}</p>}
      </div>
    </div>
  );
}

/** Button label with a stable footprint: when `acting`, the label is kept in the
 *  layout but hidden, and the Spinner is overlaid — so a click never shifts the row. */
function ActionLabel({
  label,
  icon,
  acting,
}: {
  label: string;
  icon?: ReactNode;
  acting: boolean;
}) {
  return (
    <span className="relative inline-flex items-center justify-center gap-2">
      <span className={cn('inline-flex items-center gap-2', acting && 'invisible')}>
        {icon}
        {label}
      </span>
      {acting && (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner size={16} />
        </span>
      )}
    </span>
  );
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
  serverName,
  toolName,
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
  const [pendingAction, setPendingAction] = useState<ElicitationAction | undefined>();
  const [sendFailed, setSendFailed] = useState(false);
  // Track whether the user has opened this flow's authorization link. When there
  // is no link to open, there is nothing to gate on, so treat it as already opened.
  const [urlOpened, setUrlOpened] = useState(!url);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [resolvedAction, setResolvedAction] = useState<ElicitationAction | undefined>(
    initialAction,
  );

  const submitting = pendingAction != null;
  const identity = [serverName, toolName].filter(Boolean).join(' · ') || undefined;

  const fields: ElicitationField[] = Object.entries(properties).map(([key, schema]) => ({
    key,
    schema,
  }));

  // Form mode: show the server's message, or a fallback so a schema-less request
  // never renders bare buttons over blank space.
  const formIntro =
    message || (fields.length === 0 ? localize('com_ui_elicitation_form_empty') : undefined);

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
    setSendFailed(false);
    setPendingAction(action);
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
      // Surface an inline retry affordance; the server-side flow keeps waiting
      // (or times out on its own), so the card stays interactive for a retry.
      setSendFailed(true);
    } finally {
      setPendingAction(undefined);
    }
  };

  const requiredMark = (required: boolean) =>
    required ? (
      <span aria-hidden="true" className="ml-1 text-text-destructive">
        *
      </span>
    ) : null;

  const renderField = ({ key, schema }: ElicitationField) => {
    const label = schema.title ?? key;
    const fieldId = `elicitation-${flowId}-${key}`;
    const error = errors[key];
    const required = requestedSchema?.required?.includes(key) ?? false;
    const descId = schema.description ? `${fieldId}-description` : undefined;
    const errId = error ? `${fieldId}-error` : undefined;
    const describedBy = [descId, errId].filter(Boolean).join(' ') || undefined;

    if (schema.enum) {
      return (
        <div key={key} className="flex flex-col gap-1">
          <Label htmlFor={fieldId} className="text-sm font-medium text-text-primary">
            {label}
            {requiredMark(required)}
          </Label>
          {schema.description && (
            <p id={descId} className="text-xs text-text-secondary">
              {schema.description}
            </p>
          )}
          <select
            id={fieldId}
            value={String(values[key] ?? '')}
            onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
            disabled={submitting}
            required={required}
            aria-required={required || undefined}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            className="rounded-lg border border-border-light bg-surface-primary px-3 py-2 text-sm text-text-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <option value="">{localize('com_ui_select')}</option>
            {schema.enum.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          {error && (
            <p id={errId} className="text-xs text-text-destructive">
              {error}
            </p>
          )}
        </div>
      );
    }

    if (schema.type === 'boolean') {
      return (
        <div key={key} className="flex flex-col gap-1">
          {/* Nested label grows the click target past the 16px box toward ~28px. */}
          <label htmlFor={fieldId} className="flex cursor-pointer items-center gap-2 py-1.5">
            <input
              id={fieldId}
              type="checkbox"
              checked={Boolean(values[key])}
              onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.checked }))}
              disabled={submitting}
              aria-required={required || undefined}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy}
              className="h-4 w-4 rounded border-border-light accent-ring-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
            <span className="text-sm text-text-primary">
              {label}
              {requiredMark(required)}
            </span>
          </label>
          {schema.description && (
            <p id={descId} className="text-xs text-text-secondary">
              {schema.description}
            </p>
          )}
          {error && (
            <p id={errId} className="text-xs text-text-destructive">
              {error}
            </p>
          )}
        </div>
      );
    }

    return (
      <div key={key} className="flex flex-col gap-1">
        <Label htmlFor={fieldId} className="text-sm font-medium text-text-primary">
          {label}
          {requiredMark(required)}
        </Label>
        {schema.description && (
          <p id={descId} className="text-xs text-text-secondary">
            {schema.description}
          </p>
        )}
        <Input
          id={fieldId}
          type={schema.type === 'number' || schema.type === 'integer' ? 'number' : 'text'}
          value={String(values[key] ?? '')}
          onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
          disabled={submitting}
          required={required}
          aria-required={required || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          min={schema.minimum}
          max={schema.maximum}
          minLength={schema.minLength}
          maxLength={schema.maxLength}
          className={cn(error && 'border-border-destructive focus-visible:ring-border-destructive')}
        />
        {error && (
          <p id={errId} className="text-xs text-text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  };

  if (resolvedAction) {
    const succeeded = resolvedAction === 'accept' || resolvedAction === 'complete';
    return (
      <div
        aria-live="polite"
        className="my-2 flex items-center gap-2.5 rounded-xl border border-border-light bg-surface-secondary p-3"
      >
        {succeeded ? (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" aria-hidden="true" />
        ) : (
          <XCircle className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
        )}
        <span className="text-sm text-text-secondary">
          {getStatusText(resolvedAction, localize)}
        </span>
      </div>
    );
  }

  const errorLine = sendFailed ? (
    <p role="alert" className="text-xs text-text-destructive">
      {localize('com_ui_elicitation_error')}
    </p>
  ) : null;

  if (isUrlMode) {
    return (
      <div className="my-2 rounded-xl border border-border-light bg-surface-secondary p-4">
        <div className="flex flex-col gap-3">
          <CardHeader
            icon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />}
            title={localize('com_ui_elicitation_title')}
            identity={identity}
          />
          <p className="text-sm text-text-secondary">{message}</p>
          <div className="flex flex-wrap items-center gap-2">
            {!urlOpened ? (
              <>
                {url && (
                  <Button
                    asChild
                    variant="submit"
                    size="sm"
                    aria-disabled={submitting || undefined}
                    className={cn(submitting && 'pointer-events-none opacity-50')}
                  >
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      tabIndex={submitting ? -1 : undefined}
                      onClick={() => setUrlOpened(true)}
                    >
                      <ExternalLink className="h-4 w-4" aria-hidden="true" />
                      {localize('com_ui_elicitation_open_url')}
                    </a>
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={submitting || !urlOpened}
                  onClick={() => submitAction('complete')}
                >
                  <ActionLabel
                    label={localize('com_ui_elicitation_continue')}
                    acting={pendingAction === 'complete'}
                  />
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="submit"
                  size="sm"
                  disabled={submitting}
                  onClick={() => submitAction('complete')}
                >
                  <ActionLabel
                    label={localize('com_ui_elicitation_continue')}
                    acting={pendingAction === 'complete'}
                  />
                </Button>
                {url && (
                  <Button
                    asChild
                    variant="outline"
                    size="sm"
                    aria-disabled={submitting || undefined}
                    className={cn(submitting && 'pointer-events-none opacity-50')}
                  >
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      tabIndex={submitting ? -1 : undefined}
                      onClick={() => setUrlOpened(true)}
                    >
                      <RotateCw className="h-4 w-4" aria-hidden="true" />
                      {localize('com_ui_elicitation_reopen')}
                    </a>
                  </Button>
                )}
              </>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={submitting}
              onClick={() => submitAction('cancel')}
            >
              <ActionLabel
                label={localize('com_ui_elicitation_cancel')}
                acting={pendingAction === 'cancel'}
              />
            </Button>
          </div>
          {errorLine}
        </div>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-xl border border-border-light bg-surface-secondary p-4">
      <div className="flex flex-col gap-3">
        <CardHeader
          icon={<ClipboardList className="h-4 w-4" aria-hidden="true" />}
          title={localize('com_ui_elicitation_form_title')}
          identity={identity}
        />
        {formIntro && <p className="text-sm text-text-secondary">{formIntro}</p>}
        {fields.length > 0 && (
          <div className="flex flex-col gap-3">{fields.map((field) => renderField(field))}</div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="submit"
            size="sm"
            disabled={submitting}
            onClick={() => submitAction('accept')}
          >
            <ActionLabel
              label={localize('com_ui_elicitation_submit')}
              acting={pendingAction === 'accept'}
            />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={submitting}
            onClick={() => submitAction('decline')}
          >
            <ActionLabel
              label={localize('com_ui_elicitation_decline')}
              acting={pendingAction === 'decline'}
            />
          </Button>
        </div>
        {errorLine}
      </div>
    </div>
  );
}
