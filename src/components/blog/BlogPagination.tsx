import Link from "next/link";

interface BlogPaginationProps {
  currentPage: number;
  totalPages: number;
  baseHref: string;
  extraParams?: Record<string, string>;
}

function buildHref(
  baseHref: string,
  page: number,
  extraParams?: Record<string, string>
) {
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams)) {
      params.set(key, value);
    }
  }
  const qs = params.toString();
  return qs ? `${baseHref}?${qs}` : baseHref;
}

function getPageNumbers(current: number, total: number): (number | "...")[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const pages: (number | "...")[] = [1];

  if (current > 3) pages.push("...");

  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  for (let i = start; i <= end; i++) {
    pages.push(i);
  }

  if (current < total - 2) pages.push("...");

  pages.push(total);
  return pages;
}

export function BlogPagination({
  currentPage,
  totalPages,
  baseHref,
  extraParams,
}: BlogPaginationProps) {
  if (totalPages <= 1) return null;

  const pageNumbers = getPageNumbers(currentPage, totalPages);

  return (
    <nav
      aria-label="Blog pagination"
      className="flex justify-center items-center gap-1 mt-12"
    >
      {currentPage > 1 && (
        <Link
          href={buildHref(baseHref, currentPage - 1, extraParams)}
          className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
        >
          Previous
        </Link>
      )}

      {pageNumbers.map((page, i) =>
        page === "..." ? (
          <span
            key={`ellipsis-${i}`}
            className="px-2 py-2 text-sm text-gray-400"
          >
            ...
          </span>
        ) : (
          <Link
            key={page}
            href={buildHref(baseHref, page, extraParams)}
            className={`px-3 py-2 text-sm font-medium rounded-lg ${
              page === currentPage
                ? "bg-coral text-white"
                : "text-gray-700 bg-white border border-gray-300 hover:bg-gray-50"
            }`}
          >
            {page}
          </Link>
        )
      )}

      {currentPage < totalPages && (
        <Link
          href={buildHref(baseHref, currentPage + 1, extraParams)}
          className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
        >
          Next
        </Link>
      )}
    </nav>
  );
}
