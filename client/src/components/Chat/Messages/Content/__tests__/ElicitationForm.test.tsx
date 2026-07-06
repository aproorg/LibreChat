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
});
