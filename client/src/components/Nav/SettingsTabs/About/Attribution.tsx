import { memo } from 'react';
import { useGetSearchMetaQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';

/** Only a web address becomes a link, so a response can never plant another scheme in `href`. */
const isWebUrl = (value: string): boolean => /^https?:\/\//i.test(value);

/**
 * Credit for the language data search runs on. The text and address are the server's and are
 * shown exactly as sent, in every locale: only the label above them is translated. Nothing is
 * rendered when the server sends no attribution, which is the default configuration.
 */
function Attribution() {
  const localize = useLocalize();
  const { data } = useGetSearchMetaQuery();
  const attribution = data?.attribution;

  if (!attribution?.text) {
    return null;
  }

  return (
    <section
      className="mt-4 flex flex-col gap-1 border-t border-border-light pt-4 text-xs"
      aria-labelledby="about-search-attribution-label"
      data-testid="search-attribution"
    >
      <h3 id="about-search-attribution-label" className="text-text-secondary">
        {localize('com_nav_about_search_attribution')}
      </h3>
      <p className="text-text-primary" translate="no">
        {attribution.text}
      </p>
      {isWebUrl(attribution.url) ? (
        <a
          href={attribution.url}
          target="_blank"
          rel="noopener noreferrer"
          translate="no"
          className="break-all rounded-sm text-text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary"
        >
          {attribution.url}
        </a>
      ) : (
        <p className="break-all text-text-primary" translate="no">
          {attribution.url}
        </p>
      )}
    </section>
  );
}

export default memo(Attribution);
