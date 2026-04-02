"use client";

import { useRouter } from "next/navigation";

interface BlogSortSelectProps {
  currentSort?: string;
  baseHref: string;
}

export function BlogSortSelect({
  currentSort = "newest",
  baseHref,
}: BlogSortSelectProps) {
  const router = useRouter();

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    if (value === "newest") {
      router.push(baseHref);
    } else {
      router.push(`${baseHref}?sort=${value}`);
    }
  }

  return (
    <select
      value={currentSort}
      onChange={handleChange}
      className="px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-coral focus:border-coral"
    >
      <option value="newest">Newest</option>
      <option value="oldest">Oldest</option>
    </select>
  );
}
