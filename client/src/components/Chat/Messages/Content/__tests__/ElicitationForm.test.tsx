import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RecoilRoot } from 'recoil';
import { dataService } from 'librechat-data-provider';
import ElicitationForm from '../ElicitationForm';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, options?: Record<string, string | number>) => {
    const translations: Record<string, string> = {
      com_ui_select: 'Select...',
      com_ui_elicitation_submit: 'Submit',
      com_ui_elicitation_decline: 'Decline',
      com_ui_elicitation_cancel: 'Cancel',
      com_ui_elicitation_continue: "I've authorized — continue",
      com_ui_elicitation_open_url: 'Open authorization page',
      com_ui_elicitation_completed: 'Form submitted',
      com_ui_elicitation_declined: 'Declined',
      com_ui_elicitation_cancelled: 'Cancelled',
      com_ui_elicitation_authorized: 'Authorization confirmed',
      com_ui_elicitation_field_required: '{{field}} is required',
      com_ui_elicitation_min_length: 'Minimum length is {{min}}',
      com_ui_elicitation_max_length: 'Maximum length is {{max}}',
      com_ui_elicitation_min_value: 'Minimum value is {{min}}',
      com_ui_elicitation_max_value: 'Maximum value is {{max}}',
      com_ui_elicitation_not_a_number: '{{field}} must be a number',
      com_ui_elicitation_invalid_url: "This authorization link is invalid and can't be opened.",
      com_ui_elicitation_invalid_selection: '{{field}} is not a valid selection',
      com_ui_elicitation_pattern_mismatch: "{{field}} doesn't match the required format",
      com_ui_elicitation_not_an_email: '{{field}} must be a valid email address',
      com_ui_elicitation_not_a_url: '{{field}} must be a valid URL',
      com_ui_elicitation_not_a_date: '{{field}} must be a valid date',
      com_ui_elicitation_min_items: 'Select at least {{min}}',
      com_ui_elicitation_max_items: 'Select at most {{max}}',
      com_ui_elicitation_url_domain_label: 'Domain:',
      com_ui_elicitation_suspicious_url:
        'This domain contains encoded or mixed-script characters that can be used to disguise the real destination — double-check it before continuing.',
    };
    const template = translations[key] || key;
    if (!options) {
      return template;
    }
    return template.replace(/\{\{(\w+)\}\}/g, (_match, token: string) =>
      token in options ? String(options[token]) : `{{${token}}}`,
    );
  },
}));

jest.mock('~/Providers', () => ({
  useMessageContext: () => ({ messageId: 'test-message-1' }),
  useOptionalMessagesOperations: () => ({
    getMessages: () => undefined,
    setMessages: jest.fn(),
  }),
}));

jest.mock('librechat-data-provider', () => ({
  ContentTypes: { ELICITATION: 'elicitation' },
  dataService: {
    respondToElicitation: jest.fn().mockResolvedValue({ ok: true }),
  },
}));

const baseSchema = {
  type: 'object' as const,
  properties: {
    name: {
      type: 'string' as const,
      title: 'Your Name',
      description: 'Enter your name',
    },
  },
  required: ['name'],
};

const renderForm = (overrides = {}) =>
  render(
    <RecoilRoot>
      <ElicitationForm
        flowId="test-flow-1"
        mode="form"
        message="Please provide your info"
        requestedSchema={baseSchema}
        {...overrides}
      />
    </RecoilRoot>,
  );

describe('ElicitationForm - form mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the message and fields', () => {
    renderForm();
    expect(screen.getByText('Please provide your info')).toBeInTheDocument();
    expect(screen.getByLabelText(/Your Name/)).toBeInTheDocument();
    expect(screen.getByText('Submit')).toBeInTheDocument();
    expect(screen.getByText('Decline')).toBeInTheDocument();
  });

  it('shows completed status when action is accept', () => {
    renderForm({ action: 'accept' });
    // The status is announced by a permanently-mounted sr-only span AND shown in
    // the visible card, so both copies match — see ToolCall/WebSearch tests.
    expect(screen.getAllByText('Form submitted').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Submit')).not.toBeInTheDocument();
  });

  it('shows declined status when action is decline', () => {
    renderForm({ action: 'decline' });
    expect(screen.getAllByText('Declined').length).toBeGreaterThanOrEqual(1);
  });

  it('validates required fields before submit', async () => {
    renderForm();
    fireEvent.click(screen.getByText('Submit'));
    expect(await screen.findByText('Your Name is required')).toBeInTheDocument();
    expect(dataService.respondToElicitation).not.toHaveBeenCalled();
  });

  it('submits with accept action and field values', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/Your Name/), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByText('Submit'));

    await waitFor(() => {
      expect(dataService.respondToElicitation).toHaveBeenCalledWith('test-flow-1', {
        action: 'accept',
        content: { name: 'Alice' },
      });
    });
    expect((await screen.findAllByText('Form submitted')).length).toBeGreaterThanOrEqual(1);
  });

  it('submits with decline action without content', async () => {
    renderForm();
    fireEvent.click(screen.getByText('Decline'));

    await waitFor(() => {
      expect(dataService.respondToElicitation).toHaveBeenCalledWith('test-flow-1', {
        action: 'decline',
        content: undefined,
      });
    });
  });

  it('renders enum fields as select dropdowns', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        fruit: {
          type: 'string' as const,
          title: 'Favorite Fruit',
          enum: ['Apple', 'Banana', 'Mango'],
        },
      },
    };
    renderForm({ requestedSchema: schema });
    expect(screen.getByLabelText('Favorite Fruit')).toBeInTheDocument();
    expect(screen.getByText('Apple')).toBeInTheDocument();
    expect(screen.getByText('Banana')).toBeInTheDocument();
  });

  it('renders boolean fields as checkboxes', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        agree: {
          type: 'boolean' as const,
          title: 'I agree',
        },
      },
    };
    renderForm({ requestedSchema: schema });
    const checkbox = screen.getByLabelText('I agree');
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toHaveAttribute('type', 'checkbox');
  });

  it('renders number fields with min/max', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        age: {
          type: 'integer' as const,
          title: 'Age',
          minimum: 0,
          maximum: 150,
        },
      },
    };
    renderForm({ requestedSchema: schema });
    const input = screen.getByLabelText('Age');
    expect(input).toHaveAttribute('type', 'number');
    expect(input).toHaveAttribute('min', '0');
    expect(input).toHaveAttribute('max', '150');
  });

  it('shows a "must be a number" error and blocks submit when a number field holds non-numeric text', async () => {
    // A native `<input type="number">` sanitizes non-numeric keystrokes away
    // before `onChange` ever fires, so simulate the realistic path instead: a
    // malformed/untrusted `schema.default` seeds non-numeric text straight
    // into state, bypassing the input's own DOM-level sanitization.
    const schema = {
      type: 'object' as const,
      properties: {
        age: {
          type: 'integer' as const,
          title: 'Age',
          default: 'not-a-number',
        },
      },
    };
    renderForm({ requestedSchema: schema });
    fireEvent.click(screen.getByText('Submit'));

    expect(await screen.findByText('Age must be a number')).toBeInTheDocument();
    expect(dataService.respondToElicitation).not.toHaveBeenCalled();
  });

  it('omits an empty optional numeric field instead of defaulting it to 0', async () => {
    const schema = {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string' as const,
          title: 'Your Name',
        },
        age: {
          type: 'integer' as const,
          title: 'Age',
        },
      },
      required: ['name'],
    };
    renderForm({ requestedSchema: schema });
    fireEvent.change(screen.getByLabelText(/Your Name/), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByText('Submit'));

    await waitFor(() => {
      expect(dataService.respondToElicitation).toHaveBeenCalledWith('test-flow-1', {
        action: 'accept',
        content: { name: 'Alice' },
      });
    });
  });

  it('rejects a value that fails a pattern constraint', async () => {
    const schema = {
      type: 'object' as const,
      properties: {
        zip: {
          type: 'string' as const,
          title: 'ZIP Code',
          pattern: '^\\d{5}$',
        },
      },
      required: ['zip'],
    };
    renderForm({ requestedSchema: schema });
    fireEvent.change(screen.getByLabelText(/ZIP Code/), { target: { value: 'abc12' } });
    fireEvent.click(screen.getByText('Submit'));

    expect(
      await screen.findByText("ZIP Code doesn't match the required format"),
    ).toBeInTheDocument();
    expect(dataService.respondToElicitation).not.toHaveBeenCalled();
  });

  it('renders a format: email field with an email input and rejects an invalid value', async () => {
    const schema = {
      type: 'object' as const,
      properties: {
        email: {
          type: 'string' as const,
          title: 'Email',
          format: 'email' as const,
        },
      },
      required: ['email'],
    };
    renderForm({ requestedSchema: schema });
    const input = screen.getByLabelText(/Email/);
    expect(input).toHaveAttribute('type', 'email');
    fireEvent.change(input, { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByText('Submit'));

    expect(await screen.findByText('Email must be a valid email address')).toBeInTheDocument();
    expect(dataService.respondToElicitation).not.toHaveBeenCalled();
  });

  it('renders a oneOf field as a select with titled options and submits the typed const', async () => {
    const schema = {
      type: 'object' as const,
      properties: {
        plan: {
          title: 'Plan',
          oneOf: [
            { const: 'basic', title: 'Basic' },
            { const: 'pro', title: 'Pro' },
          ],
        },
      },
      required: ['plan'],
    };
    renderForm({ requestedSchema: schema });
    expect(screen.getByText('Pro')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Plan/), { target: { value: 'pro' } });
    fireEvent.click(screen.getByText('Submit'));

    await waitFor(() => {
      expect(dataService.respondToElicitation).toHaveBeenCalledWith('test-flow-1', {
        action: 'accept',
        content: { plan: 'pro' },
      });
    });
  });

  it('renders a type: array field as a multi-select checkbox group and submits a real array', async () => {
    const schema = {
      type: 'object' as const,
      properties: {
        labels: {
          type: 'array' as const,
          title: 'Labels',
          items: { enum: ['bug', 'feature', 'docs'] },
        },
      },
      required: ['labels'],
    };
    renderForm({ requestedSchema: schema });
    fireEvent.click(screen.getByLabelText('bug'));
    fireEvent.click(screen.getByLabelText('docs'));
    fireEvent.click(screen.getByText('Submit'));

    await waitFor(() => {
      expect(dataService.respondToElicitation).toHaveBeenCalledWith('test-flow-1', {
        action: 'accept',
        content: { labels: ['bug', 'docs'] },
      });
    });
  });
});

const renderUrlForm = (overrides = {}) =>
  render(
    <RecoilRoot>
      <ElicitationForm
        flowId="test-flow-url-1"
        mode="url"
        message="Please authorize access to your account"
        url="https://example.com/authorize?token=abc"
        {...overrides}
      />
    </RecoilRoot>,
  );

describe('ElicitationForm - url mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the message and an authorization link opening in a new tab', () => {
    renderUrlForm();
    expect(screen.getByText('Please authorize access to your account')).toBeInTheDocument();

    const link = screen.getByText('Open authorization page').closest('a');
    expect(link).toHaveAttribute('href', 'https://example.com/authorize?token=abc');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('renders Continue and Cancel controls', () => {
    renderUrlForm();
    expect(screen.getByText("I've authorized — continue")).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('posts action "complete" when Continue is clicked and shows the authorized status', async () => {
    renderUrlForm();
    fireEvent.click(screen.getByText('Open authorization page'));
    fireEvent.click(screen.getByText("I've authorized — continue"));

    await waitFor(() => {
      expect(dataService.respondToElicitation).toHaveBeenCalledWith('test-flow-url-1', {
        action: 'complete',
        content: undefined,
      });
    });
    expect((await screen.findAllByText('Authorization confirmed')).length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('posts action "cancel" when Cancel is clicked and shows the cancelled status', async () => {
    renderUrlForm();
    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => {
      expect(dataService.respondToElicitation).toHaveBeenCalledWith('test-flow-url-1', {
        action: 'cancel',
        content: undefined,
      });
    });
    expect((await screen.findAllByText('Cancelled')).length).toBeGreaterThanOrEqual(1);
  });

  it('shows the authorized status immediately when a persisted action is provided', () => {
    renderUrlForm({ action: 'complete' });
    expect(screen.getAllByText('Authorization confirmed').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Open authorization page')).not.toBeInTheDocument();
  });

  it('renders no clickable anchor and a warning for a javascript: URL', () => {
    renderUrlForm({ url: 'javascript:alert(1)' });
    expect(screen.queryByText('Open authorization page')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(
      screen.getByText("This authorization link is invalid and can't be opened."),
    ).toBeInTheDocument();
  });

  it('renders no clickable anchor for a data: URL', () => {
    renderUrlForm({ url: 'data:text/html,<script>alert(1)</script>' });
    expect(screen.queryByText('Open authorization page')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('keeps Continue disabled when the authorization URL is unsafe', () => {
    renderUrlForm({ url: 'javascript:alert(1)' });
    expect(screen.getByText("I've authorized — continue").closest('button')).toBeDisabled();
  });

  it('shows the full URL as visible text and highlights its domain before the user can click', () => {
    renderUrlForm();
    // The raw URL must be readable up front — not just present as an href.
    expect(screen.getByText('https://example.com/authorize?token=abc')).toBeInTheDocument();
    expect(screen.getByText('example.com')).toBeInTheDocument();
  });

  it('warns when the authorization URL has a Punycode/homograph domain', () => {
    renderUrlForm({ url: 'https://xn--80ak6aa92e.com/authorize' });
    expect(
      screen.getByText(
        'This domain contains encoded or mixed-script characters that can be used to disguise the real destination — double-check it before continuing.',
      ),
    ).toBeInTheDocument();
  });

  it('does not warn for an ordinary ASCII domain', () => {
    renderUrlForm();
    expect(
      screen.queryByText(
        'This domain contains encoded or mixed-script characters that can be used to disguise the real destination — double-check it before continuing.',
      ),
    ).not.toBeInTheDocument();
  });

  it('shows an inline error and stays interactive when the response fails to send', async () => {
    (dataService.respondToElicitation as jest.Mock).mockRejectedValueOnce(new Error('network'));
    renderUrlForm();
    fireEvent.click(screen.getByText('Cancel'));

    expect(await screen.findByText("Couldn't send your response — try again.")).toBeInTheDocument();
    // The card is still interactive for a retry.
    expect(screen.getByText("I've authorized — continue")).toBeInTheDocument();
  });

  it('treats a 409 as already-resolved and shows the resolved status instead of the retry error', async () => {
    const conflictError = Object.assign(new Error('Conflict'), {
      response: { status: 409 },
    });
    (dataService.respondToElicitation as jest.Mock).mockRejectedValueOnce(conflictError);
    renderUrlForm();
    fireEvent.click(screen.getByText('Open authorization page'));
    fireEvent.click(screen.getByText("I've authorized — continue"));

    expect((await screen.findAllByText('Authorization confirmed')).length).toBeGreaterThanOrEqual(
      1,
    );
    expect(screen.queryByText("Couldn't send your response — try again.")).not.toBeInTheDocument();
  });
});
