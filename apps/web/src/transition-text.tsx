import { useEffect, useRef, useState } from "react";

function transitionDurationMs() {
  if (typeof window === "undefined") return 0;
  const raw = window.getComputedStyle(document.documentElement).getPropertyValue("--text-swap-dur").trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return 150;
  return raw.endsWith("s") && !raw.endsWith("ms") ? value * 1_000 : value;
}

function reducedMotion() {
  return typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function TransitionText({ value }: { value: string }) {
  const [displayed, setDisplayed] = useState(value);
  const [phase, setPhase] = useState<"" | "is-exit" | "is-enter-start">("");
  const displayedRef = useRef(value);
  const elementRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let timer = 0;
    let frame = 0;
    let cancelled = false;

    if (value === displayedRef.current) {
      setPhase("");
      return;
    }
    if (reducedMotion()) {
      displayedRef.current = value;
      setDisplayed(value);
      setPhase("");
      return;
    }

    setPhase("is-exit");
    timer = window.setTimeout(() => {
      if (cancelled) return;
      displayedRef.current = value;
      setDisplayed(value);
      setPhase("is-enter-start");
      frame = window.requestAnimationFrame(() => {
        if (cancelled) return;
        void elementRef.current?.offsetHeight;
        setPhase("");
      });
    }, transitionDurationMs());

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
    };
  }, [value]);

  return <span ref={elementRef} className={`t-text-swap ${phase}`.trim()} aria-hidden="true">{displayed}</span>;
}
