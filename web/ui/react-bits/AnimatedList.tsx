// Adapted React Bits AnimatedList, David Haz, c83b5e7e026f003af33ff9ebc3d93afb5c86ad22.
// Source: src/content/Components/AnimatedList. License: ../../licenses/react-bits-LICENSE.md.
// Native navigation replaces the upstream global Tab interception and generic clickable divs.
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import {
  motion,
  useInView,
  useReducedMotion,
  MotionConfig,
} from "motion/react";
import {
  navigationIndex,
  sectionFromHash,
  type WorkspaceSection,
  type NavigationItem,
} from "../navigation-state.ts";
import "./AnimatedList.css";

function Icon({ kind }: { kind: WorkspaceSection }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === "workspace" ? (
        <>
          <rect x="3" y="3" width="7" height="7" rx="1.8" />
          <rect x="14" y="3" width="7" height="7" rx="1.8" />
          <rect x="3" y="14" width="7" height="7" rx="1.8" />
          <rect x="14" y="14" width="7" height="7" rx="1.8" />
        </>
      ) : kind === "market" ? (
        <>
          <path d="m4 9 2-5h12l2 5M4 9h16M5 9v11h14V9M9 20v-6h6v6" />
          <path d="M3 9v2a2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 2-2" />
        </>
      ) : kind === "post" ? (
        <>
          <rect x="3" y="3" width="18" height="18" rx="4" />
          <path d="M12 8v8M8 12h8" />
        </>
      ) : kind === "lookup" ? (
        <>
          <rect x="5" y="3" width="14" height="18" rx="2" />
          <path d="M9 8h6M9 12h6M9 16h4" />
        </>
      ) : kind === "demo" ? (
        <>
          <circle cx="12" cy="12" r="2" />
          <path d="M8 7a7 7 0 0 0 0 10M16 7a7 7 0 0 1 0 10M5 4a11 11 0 0 0 0 16M19 4a11 11 0 0 1 0 16" />
        </>
      ) : (
        <>
          <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" />
          <path d="m8.5 12 2.5 2.5 4.5-5" />
        </>
      )}
    </svg>
  );
}
const ITEMS: ReadonlyArray<NavigationItem> = [
  { id: "workspace", label: "Overview" },
  { id: "lookup", label: "Job evidence" },
  { id: "demo", label: "Live demo" },
  { id: "trust", label: "Trust & limits" },
];
function AnimatedItem({
  children,
  index,
}: {
  children: ReactNode;
  index: number;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const visible = useInView(ref, { once: true, amount: 0.2 });
  const reduced = useReducedMotion();
  return (
    <motion.li
      ref={ref}
      initial={reduced ? false : { opacity: 0, x: -6 }}
      animate={{ opacity: visible ? 1 : 0, x: visible ? 0 : -6 }}
      transition={{
        duration: reduced ? 0 : 0.22,
        delay: reduced ? 0 : index * 0.035,
      }}
    >
      {children}
    </motion.li>
  );
}
export function AnimatedList({
  preview = false,
  onNavigate,
  items = ITEMS,
  defaultSection = "workspace",
}: {
  preview?: boolean;
  onNavigate?: () => void;
  items?: ReadonlyArray<NavigationItem>;
  defaultSection?: WorkspaceSection;
}) {
  const [active, setActive] = useState<WorkspaceSection>(() =>
    preview
      ? "workspace"
      : sectionFromHash(
          window.location.hash,
          items === ITEMS ? undefined : items,
          defaultSection,
        ),
  );
  const anchors = useRef<Array<HTMLAnchorElement | null>>([]);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (preview) return;
    const sync = () =>
      setActive(
        sectionFromHash(
          window.location.hash,
          items === ITEMS ? undefined : items,
          defaultSection,
        ),
      );
    const inspect = () => setActive("lookup");
    window.addEventListener("hashchange", sync);
    document.addEventListener("proven-job", inspect);
    return () => {
      window.removeEventListener("hashchange", sync);
      document.removeEventListener("proven-job", inspect);
    };
  }, [preview, items, defaultSection]);
  function keyboard(event: KeyboardEvent<HTMLElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = anchors.current.findIndex(
      (anchor) => anchor === document.activeElement,
    );
    const next = navigationIndex(event.key, index, items.length);
    if (next === null) return;
    event.preventDefault();
    anchors.current[next]?.focus();
  }
  function select(event: MouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    setActive(
      items.find((item) => item.id === event.currentTarget.dataset.section)
        ?.id ?? "workspace",
    );
    onNavigate?.();
  }
  return (
    <MotionConfig reducedMotion="user">
      <nav
        className="animated-navigation"
        aria-label={preview ? "Workspace navigation preview" : "App navigation"}
        onKeyDown={preview ? undefined : keyboard}
      >
        <ul className="animated-list">
          {items.map((item, index) => (
            <AnimatedItem key={item.id} index={index}>
              <a
                ref={(node) => {
                  anchors.current[index] = node;
                }}
                className="animated-link"
                href={preview ? undefined : (item.href ?? `#${item.id}`)}
                data-section={item.id}
                aria-current={active === item.id ? "location" : undefined}
                onClick={preview ? undefined : select}
              >
                {active === item.id && (
                  <motion.span
                    className="animated-active"
                    layoutId="workspace-active-pill"
                    transition={
                      reduced
                        ? { duration: 0 }
                        : { type: "spring", stiffness: 380, damping: 35 }
                    }
                    aria-hidden="true"
                  />
                )}
                <Icon kind={item.icon ?? item.id} />
                <span>{item.label}</span>
              </a>
            </AnimatedItem>
          ))}
        </ul>
      </nav>
    </MotionConfig>
  );
}
