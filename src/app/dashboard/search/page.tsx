import { SearchView } from "./search-view";

export default async function SearchRoute({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  return <SearchView initialQuery={q ?? ""} />;
}
