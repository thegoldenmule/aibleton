import type { ReactNode } from "react";
import { PanelHeader } from "./ui/PanelHeader";

/**
 * The frame around whatever the workspace column is showing — the song, or one
 * of the libraries. It is the only part of the page that changes as you
 * navigate; the header, the rail and the two bandmate panes stay put.
 *
 * It also owns the column's **single** scroller. The document never scrolls, so
 * every column is a fixed-height flex box with exactly one `overflow-y-auto`
 * child; a page inside this panel must not add its own.
 */
export function WorkspacePanel({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-h-0 flex-col gap-2 overflow-hidden rounded-md border border-line bg-panel p-3">
      <PanelHeader title={title} meta={meta} />
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">{children}</div>
    </section>
  );
}
