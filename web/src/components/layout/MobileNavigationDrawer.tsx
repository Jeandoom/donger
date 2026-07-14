import { Menu, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NavigationSidebar } from "./NavigationSidebar";

export function MobileNavigationDrawer() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
      triggerRef.current?.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="打开主导航"
        className="inline-flex min-h-11 min-w-11 items-center justify-center lg:hidden"
        onClick={() => setOpen(true)}
      >
        <Menu size={20} />
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="关闭主导航遮罩"
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="主导航"
            className="relative h-full w-[min(84vw,20rem)] bg-background shadow-xl"
          >
            <button
              type="button"
              aria-label="关闭主导航"
              className="absolute right-2 top-2 z-10 inline-flex min-h-11 min-w-11 items-center justify-center"
              onClick={() => setOpen(false)}
            >
              <X size={20} />
            </button>
            <NavigationSidebar className="w-full border-r-0" onNavigate={() => setOpen(false)} />
          </div>
        </div>
      ) : null}
    </>
  );
}
