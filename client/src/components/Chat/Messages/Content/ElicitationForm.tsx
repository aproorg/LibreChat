import { useMemo, useState } from 'react';
import { Button, Input, Label, Spinner } from '@librechat/client';
import { ContentTypes, dataService } from 'librechat-data-provider';
import {
  ShieldCheck,
  ClipboardList,
  ExternalLink,
  RotateCw,
  CheckCircle2,
  XCircle,
  TriangleAlert,
} from 'lucide-react';
import type { Agents } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { useMessageContext, useOptionalMessagesOperations } from '~/Providers';
import { useLocalize } from '~/hooks';
import cn from '~/utils/cn';

type ElicitationAction = Agents.ElicitationAction;

type ElicitationField = {
  key: string;
  schema: Agents.ElicitationPropertySchema;
};

type FieldValue = string | number | boolean | string[] | number[];

/** Normalizes a `type: 'array'` property's option source — either a plain
 *  `items.enum` value list or titled `items.anyOf` const/title pairs — into a
 *  single shape the multi-select checkbox group renders from. */
type ArrayOption = { value: string | number; label: string };

function getArrayOptions(schema: Agents.ElicitationPropertySchema): ArrayOption[] {
  if (schema.items?.anyOf) {
    return schema.items.anyOf.map((option) => ({
      value: option.const as string | number,
      label: option.title ?? String(option.const),
    }));
  }
  if (schema.items?.enum) {
    return schema.items.enum.map((value) => ({ value, label: String(value) }));
  }
  return [];
}

function getDefaultValues(
  properties: Record<string, Agents.ElicitationPropertySchema>,
): Record<string, FieldValue> {
  const defaults: Record<string, FieldValue> = {};
  for (const [key, schema] of Object.entries(properties)) {
    if (schema.default != null) {
      defaults[key] = schema.default;
    } else if (schema.type === 'boolean') {
      defaults[key] = false;
    } else if (schema.type === 'array') {
      defaults[key] = [];
    } else {
      defaults[key] = '';
    }
  }
  return defaults;
}

/** Lightweight `format: 'email'` check — not RFC-5322-exhaustive, just enough
 *  to catch obviously malformed input before it's sent to the server. */
function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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

/** Only `http(s)` targets are safe to render as a clickable link — a malicious or
 *  compromised MCP server could otherwise supply a `javascript:`/`data:` URL that
 *  executes script in the LibreChat origin the moment the user clicks it. */
function getSafeUrl(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Hostname of a URL already known to be a safe http(s) target (see
 *  `getSafeUrl`) — used to highlight the domain the user is about to visit,
 *  mitigating long-path/subdomain spoofing where the real host is buried. */
function getHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** True when any label of the hostname is IDNA/Punycode-encoded (`xn--...`).
 *  The URL parser itself converts any non-ASCII (mixed-script/homograph)
 *  hostname label to its `xn--` form, so this single check also catches
 *  Cyrillic/Greek lookalike domains — not just literal Punycode input. */
function hasPunycodeLabel(hostname: string): boolean {
  return hostname.split('.').some((label) => label.toLowerCase().startsWith('xn--'));
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
  const { messageId } = useMessageContext();
  const { getMessages, setMessages } = useOptionalMessagesOperations();
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
  // Never render the server-supplied `url` as an href unless it's http(s) — see
  // `getSafeUrl`. A present-but-unsafe `url` renders a warning instead of a link
  // and permanently withholds the `urlOpened` unlock (no link, nothing to click).
  const safeUrl = useMemo(() => getSafeUrl(url), [url]);
  // Domain highlight + Punycode/homograph warning, shown alongside the full URL
  // text so the user can examine the real destination before clicking anything.
  const hostname = useMemo(() => (safeUrl ? getHostname(safeUrl) : ''), [safeUrl]);
  const suspiciousHostname = useMemo(() => hasPunycodeLabel(hostname), [hostname]);

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
      const label = schema.title ?? key;
      const isEmpty =
        schema.type === 'array'
          ? !Array.isArray(val) || val.length === 0
          : val === '' || val == null;
      if (required && isEmpty) {
        newErrors[key] = localize('com_ui_elicitation_field_required', { field: label });
      }
      if (schema.type === 'string' && typeof val === 'string') {
        if (schema.minLength != null && val.length < schema.minLength) {
          newErrors[key] = localize('com_ui_elicitation_min_length', { min: schema.minLength });
        }
        if (schema.maxLength != null && val.length > schema.maxLength) {
          newErrors[key] = localize('com_ui_elicitation_max_length', { max: schema.maxLength });
        }
        if (val !== '' && schema.pattern != null) {
          let matchesPattern = true;
          try {
            matchesPattern = new RegExp(schema.pattern).test(val);
          } catch {
            // A malformed server-supplied pattern shouldn't block the user.
            matchesPattern = true;
          }
          if (!matchesPattern) {
            newErrors[key] = localize('com_ui_elicitation_pattern_mismatch', { field: label });
          }
        }
        if (val !== '' && schema.format === 'email' && !isValidEmail(val)) {
          newErrors[key] = localize('com_ui_elicitation_not_an_email', { field: label });
        }
        if (val !== '' && schema.format === 'uri' && getSafeUrl(val) == null) {
          newErrors[key] = localize('com_ui_elicitation_not_a_url', { field: label });
        }
        if (
          val !== '' &&
          (schema.format === 'date' || schema.format === 'date-time') &&
          Number.isNaN(Date.parse(val))
        ) {
          newErrors[key] = localize('com_ui_elicitation_not_a_date', { field: label });
        }
      }
      if ((schema.type === 'number' || schema.type === 'integer') && val !== '' && val != null) {
        const num = Number(val);
        if (Number.isNaN(num)) {
          newErrors[key] = localize('com_ui_elicitation_not_a_number', { field: label });
        } else if (schema.minimum != null && num < schema.minimum) {
          newErrors[key] = localize('com_ui_elicitation_min_value', { min: schema.minimum });
        } else if (schema.maximum != null && num > schema.maximum) {
          newErrors[key] = localize('com_ui_elicitation_max_value', { max: schema.maximum });
        }
      }
      if (schema.oneOf && val !== '' && val != null) {
        const isAllowed = schema.oneOf.some((option) => String(option.const) === String(val));
        if (!isAllowed) {
          newErrors[key] = localize('com_ui_elicitation_invalid_selection', { field: label });
        }
      }
      if (schema.type === 'array') {
        const arr = Array.isArray(val) ? val : [];
        if (schema.minItems != null && arr.length < schema.minItems) {
          newErrors[key] = localize('com_ui_elicitation_min_items', { min: schema.minItems });
        }
        if (schema.maxItems != null && arr.length > schema.maxItems) {
          newErrors[key] = localize('com_ui_elicitation_max_items', { max: schema.maxItems });
        }
      }
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  /** Writes the resolved `action`/`content` onto this flow's `ELICITATION` content
   *  part in the owning message, so the resolved state isn't held only in this
   *  component's local `resolvedAction` state. Mirrors the write-back
   *  `useStepHandler` applies for the `on_elicitation_resolved` SSE event. A no-op
   *  when rendered outside a `MessagesViewProvider`. */
  const patchResolvedElicitation = (
    action: ElicitationAction,
    resolvedContent?: Record<string, FieldValue>,
  ) => {
    const messages = getMessages();
    if (!messages) {
      return;
    }
    let didPatch = false;
    const updatedMessages = messages.map((msg) => {
      if (msg.messageId !== messageId || !msg.content) {
        return msg;
      }
      const updatedContent = msg.content.map((part) => {
        if (part?.type !== ContentTypes.ELICITATION || part.elicitation?.flowId !== flowId) {
          return part;
        }
        didPatch = true;
        return {
          ...part,
          elicitation: { ...part.elicitation, action, content: resolvedContent },
        };
      });
      return { ...msg, content: updatedContent };
    });
    if (didPatch) {
      setMessages(updatedMessages);
    }
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
              fields
                // Omit empty optional fields instead of defaulting them to 0/null —
                // required fields are already guaranteed non-empty by `validate`.
                .filter(({ key, schema }) => {
                  const val = values[key];
                  if (schema.type === 'array') {
                    return Array.isArray(val) && val.length > 0;
                  }
                  return val !== '' && val != null;
                })
                .map(({ key, schema }) => {
                  const val = values[key];
                  if (schema.type === 'number' || schema.type === 'integer') {
                    return [key, Number(val)];
                  }
                  if (schema.oneOf) {
                    // The `<select>` always yields a string; recover the schema's
                    // typed `const` (string | number | boolean) for the payload.
                    const match = schema.oneOf.find(
                      (option) => String(option.const) === String(val),
                    );
                    return [key, match ? match.const : val];
                  }
                  return [key, val];
                }),
            )
          : undefined;
      await dataService.respondToElicitation(flowId, { action, content });
      setResolvedAction(action);
      patchResolvedElicitation(action, content);
    } catch (error) {
      // A 409 means the completion route atomically lost the race (e.g. the
      // same card acted on in another tab, or a double-submit) — the flow IS
      // resolved, just not by this request. Treat it like the success path
      // instead of a misleading "try again".
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 409) {
        // No content: this request lost the race, so whatever the winner sent is
        // what the server actually stored — not our payload.
        setResolvedAction(action);
        patchResolvedElicitation(action);
      } else {
        // Surface an inline retry affordance; the server-side flow keeps waiting
        // (or times out on its own), so the card stays interactive for a retry.
        setSendFailed(true);
      }
    } finally {
      setPendingAction(undefined);
    }
  };

  const markUrlOpened = () => setUrlOpened(true);

  /** Toggles one option of a `type: 'array'` (multi-select) field's checkbox
   *  group, keeping the stored value a real array rather than a delimited
   *  string — the payload builder below sends it as JSON array as-is. */
  const toggleArrayValue = (key: string, optionValue: string | number, checked: boolean) => {
    setValues((prev) => {
      const current = Array.isArray(prev[key]) ? (prev[key] as Array<string | number>) : [];
      const next = checked
        ? [...current, optionValue]
        : current.filter((value) => value !== optionValue);
      return { ...prev, [key]: next as string[] | number[] };
    });
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

    if (schema.type === 'array') {
      const options = getArrayOptions(schema);
      const selected = Array.isArray(values[key]) ? (values[key] as Array<string | number>) : [];
      return (
        <fieldset key={key} className="flex flex-col gap-1">
          <legend className="text-sm font-medium text-text-primary">
            {label}
            {requiredMark(required)}
          </legend>
          {schema.description && (
            <p id={descId} className="text-xs text-text-secondary">
              {schema.description}
            </p>
          )}
          <div className="flex flex-col gap-1.5" aria-describedby={describedBy}>
            {options.map((option) => {
              const optionId = `${fieldId}-${option.value}`;
              return (
                // Nested label grows the click target past the 16px box toward ~28px.
                <label
                  key={optionId}
                  htmlFor={optionId}
                  className="flex cursor-pointer items-center gap-2 py-1"
                >
                  <input
                    id={optionId}
                    type="checkbox"
                    checked={selected.includes(option.value)}
                    onChange={(e) => toggleArrayValue(key, option.value, e.target.checked)}
                    disabled={submitting}
                    className="h-4 w-4 rounded border-border-light accent-ring-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  />
                  <span className="text-sm text-text-primary">{option.label}</span>
                </label>
              );
            })}
          </div>
          {error && (
            <p id={errId} className="text-xs text-text-destructive">
              {error}
            </p>
          )}
        </fieldset>
      );
    }

    if (schema.oneOf) {
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
            {schema.oneOf.map((option) => (
              <option key={String(option.const)} value={String(option.const)}>
                {option.title ?? String(option.const)}
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
            {schema.enum.map((opt, i) => (
              <option key={opt} value={opt}>
                {schema.enumNames?.[i] ?? opt}
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

    // Maps `format` to the closest native input type/keyboard for each — the
    // format-specific `validate()` checks below still run since native
    // constraint validation alone isn't localized or wired to `errors`.
    let inputType: 'number' | 'email' | 'url' | 'date' | 'datetime-local' | 'text' = 'text';
    if (schema.type === 'number' || schema.type === 'integer') {
      inputType = 'number';
    } else if (schema.format === 'email') {
      inputType = 'email';
    } else if (schema.format === 'uri') {
      inputType = 'url';
    } else if (schema.format === 'date') {
      inputType = 'date';
    } else if (schema.format === 'date-time') {
      inputType = 'datetime-local';
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
          type={inputType}
          pattern={schema.pattern}
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

  const errorLine = sendFailed ? (
    <p role="alert" className="text-xs text-text-destructive">
      {localize('com_ui_elicitation_error')}
    </p>
  ) : null;

  // Announced via the permanently-mounted `sr-only` span below, decoupled from
  // the visible card's mount/unmount — mirrors `ToolCall`/`WebSearch`/
  // `RetrievalCall`/`CodeAnalyze`, whose live region persists across state
  // changes rather than mounting fresh alongside its own content.
  const statusText = resolvedAction ? getStatusText(resolvedAction, localize) : '';

  let card: ReactNode;
  if (resolvedAction) {
    const succeeded = resolvedAction === 'accept' || resolvedAction === 'complete';
    // Once resolved, recede to a muted one-line trace at the sibling tool call's
    // "Completed …" altitude rather than lingering as a full card.
    card = (
      <div className="my-1.5 flex h-5 items-center gap-2 text-text-secondary">
        {succeeded ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" aria-hidden="true" />
        ) : (
          <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className="text-xs">{statusText}</span>
      </div>
    );
  } else if (isUrlMode) {
    card = (
      <div className="my-2 rounded-xl border border-border-light bg-surface-secondary p-4">
        <div className="flex flex-col gap-3">
          <CardHeader
            icon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />}
            title={localize('com_ui_elicitation_title')}
            identity={identity}
          />
          <p className="text-sm text-text-secondary">{message}</p>
          {/* MUST be visible and readable before the user clicks anything — see
              `getSafeUrl`/`getHostname`/`hasPunycodeLabel`. Rendered above the
              button row regardless of `urlOpened` so it stays available to
              re-examine before Continue, too. */}
          {safeUrl && (
            <div className="flex flex-col gap-1 rounded-lg border border-border-light bg-surface-tertiary p-2.5">
              <p className="text-xs text-text-secondary">
                {localize('com_ui_elicitation_url_domain_label')}{' '}
                <span className="font-semibold text-text-primary">{hostname}</span>
              </p>
              <p title={safeUrl} className="break-all text-xs text-text-secondary">
                {safeUrl}
              </p>
              {suspiciousHostname && (
                <p role="alert" className="flex items-center gap-1.5 text-xs text-text-warning">
                  <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {localize('com_ui_elicitation_suspicious_url')}
                </p>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {!urlOpened ? (
              <>
                {safeUrl ? (
                  <Button
                    asChild
                    variant="submit"
                    size="sm"
                    aria-disabled={submitting || undefined}
                    className={cn(submitting && 'pointer-events-none opacity-50')}
                  >
                    <a
                      href={safeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      tabIndex={submitting ? -1 : undefined}
                      onClick={markUrlOpened}
                      onAuxClick={markUrlOpened}
                    >
                      <ExternalLink className="h-4 w-4" aria-hidden="true" />
                      {localize('com_ui_elicitation_open_url')}
                    </a>
                  </Button>
                ) : (
                  url && (
                    <p role="alert" className="text-xs text-text-destructive">
                      {localize('com_ui_elicitation_invalid_url')}
                    </p>
                  )
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
                {safeUrl && (
                  <Button
                    asChild
                    variant="outline"
                    size="sm"
                    aria-disabled={submitting || undefined}
                    className={cn(submitting && 'pointer-events-none opacity-50')}
                  >
                    <a
                      href={safeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      tabIndex={submitting ? -1 : undefined}
                      onClick={markUrlOpened}
                      onAuxClick={markUrlOpened}
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
  } else {
    card = (
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

  return (
    <>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {statusText}
      </span>
      {card}
    </>
  );
}
