import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderOpen,
  ImageIcon,
} from "lucide-react";
import { cn } from "../../lib/utils";
import type { FileNode } from "../../lib/files";

const IMG_EXT = ["jpg", "jpeg", "png", "gif", "webp"];

function isImage(name: string): boolean {
  return IMG_EXT.includes(name.split(".").pop()?.toLowerCase() ?? "");
}

export function FileTree(props: {
  nodes: FileNode[];
  selectedPath?: string;
  onSelect: (path: string) => void;
  downloadUrlFor: (path: string) => string;
}) {
  const { nodes, selectedPath, onSelect, downloadUrlFor } = props;
  // 默认展开顶层目录
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(nodes.filter((n) => n.isDir).map((n) => n.path)),
  );

  function toggle(path: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <div className="select-none py-1 text-sm">
      {nodes.map((n) => (
        <Row
          key={n.path}
          node={n}
          depth={0}
          expanded={expanded}
          selectedPath={selectedPath}
          onToggle={toggle}
          onSelect={onSelect}
          downloadUrlFor={downloadUrlFor}
        />
      ))}
    </div>
  );
}

function Row(props: {
  node: FileNode;
  depth: number;
  expanded: Set<string>;
  selectedPath?: string;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  downloadUrlFor: (path: string) => string;
}) {
  const { node, depth, expanded, selectedPath, onToggle, onSelect, downloadUrlFor } = props;
  const pad = { paddingLeft: `${depth * 12 + 8}px` };
  const isOpen = expanded.has(node.path);

  if (node.isDir) {
    return (
      <div>
        <button
          type="button"
          className="flex w-full items-center gap-1 py-0.5 pr-2 text-left hover:bg-accent"
          style={pad}
          onClick={() => onToggle(node.path)}
        >
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {isOpen ? <FolderOpen size={14} /> : <Folder size={14} />}
          <span className="truncate">{node.name}</span>
        </button>
        {isOpen &&
          node.children?.map((c) => (
            <Row
              key={c.path}
              node={c}
              depth={depth + 1}
              expanded={expanded}
              selectedPath={selectedPath}
              onToggle={onToggle}
              onSelect={onSelect}
              downloadUrlFor={downloadUrlFor}
            />
          ))}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group flex cursor-pointer items-center gap-1 py-0.5 pr-2",
        selectedPath === node.path ? "bg-accent" : "hover:bg-accent",
      )}
      style={pad}
      onClick={() => onSelect(node.path)}
    >
      <span className="w-3.5 shrink-0" />
      {isImage(node.name) ? <ImageIcon size={14} /> : <FileText size={14} />}
      <span className="flex-1 truncate">{node.name}</span>
      <a
        href={downloadUrlFor(node.path)}
        onClick={(e) => e.stopPropagation()}
        className="hidden text-muted-foreground hover:text-foreground group-hover:block"
        title="下载"
      >
        <Download size={14} />
      </a>
    </div>
  );
}
