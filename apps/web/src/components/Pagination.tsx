import { Button } from './ui/button';
export default function Pagination({
  hasNext,
  total,
  page,
  pageSize,
  onPage,
}: {
  hasNext?: boolean;
  total?: number;
  page: number;
  pageSize?: number;
  onPage: (page: number) => void;
}) {
  if (total === undefined || !pageSize) return null;
  return (
    <div className="pagination">
      <span>
        Page {page} · {total} records
      </span>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={page === 1}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={hasNext === undefined ? page * pageSize >= total : !hasNext}
          onClick={() => onPage(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
