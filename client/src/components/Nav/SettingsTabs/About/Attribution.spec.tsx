import { render, screen } from '@testing-library/react';
import Attribution from './Attribution';

const mockUseGetSearchMetaQuery = jest.fn();
jest.mock('~/data-provider', () => ({
  useGetSearchMetaQuery: () => mockUseGetSearchMetaQuery(),
}));

/** Stands in for any locale: every translated string is the key with the locale's tag. */
let mockLocale = 'en';
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => `${mockLocale}:${key}`,
}));

const attribution = {
  text: 'The Example Lexicon. Example Institute for Language. Author and editor A. Writer.',
  url: 'https://lexicon.example.org',
};

beforeEach(() => {
  mockLocale = 'en';
  mockUseGetSearchMetaQuery.mockReturnValue({ data: { attribution } });
});

describe('Attribution', () => {
  it("shows the server's text and address exactly as sent, under a localized label", () => {
    render(<Attribution />);

    expect(screen.getByText(attribution.text)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: attribution.url });
    expect(link).toHaveAttribute('href', attribution.url);
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(
      screen.getByRole('region', { name: 'en:com_nav_about_search_attribution' }),
    ).toBeInTheDocument();
  });

  it('localizes only the label: the text and address are the same in every locale', () => {
    mockLocale = 'xx';
    render(<Attribution />);

    expect(
      screen.getByRole('heading', { name: 'xx:com_nav_about_search_attribution' }),
    ).toBeInTheDocument();
    expect(screen.getByText(attribution.text)).toBeInTheDocument();
    expect(screen.getByText(attribution.text)).toHaveAttribute('translate', 'no');
    expect(screen.getByRole('link', { name: attribution.url })).toHaveAttribute('translate', 'no');
  });

  it.each([
    ['the default configuration', { data: {} }],
    ['a response still loading', { data: undefined }],
    ['a failed request', { data: undefined, isError: true }],
    ['an empty attribution', { data: { attribution: { text: '', url: '' } } }],
  ])('renders nothing with %s', (_name, result) => {
    mockUseGetSearchMetaQuery.mockReturnValue(result);
    const { container } = render(<Attribution />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows an address that is not a web link as text, never as a link', () => {
    mockUseGetSearchMetaQuery.mockReturnValue({
      data: { attribution: { text: attribution.text, url: 'javascript:alert(1)' } },
    });
    render(<Attribution />);

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument();
  });
});
