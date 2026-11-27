import Link from 'next/link';
import { Fragment } from 'react';

/**
 * Narrator names, each linking to the narrator's page
 */
const NarratorLinks = ({
  narrators,
  className = 'hover:underline',
}: {
  narrators: string[];
  className?: string;
}) => (
  <>
    {narrators.map((name, index) => (
      <Fragment key={`narrator-${name}`}>
        {index > 0 && ', '}
        <Link
          href={`/narrator/${encodeURIComponent(name)}`}
          className={className}
          data-testid="narrator-link"
        >
          {name}
        </Link>
      </Fragment>
    ))}
  </>
);

export default NarratorLinks;
