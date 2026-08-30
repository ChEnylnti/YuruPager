import type { PreviewLaunchResult } from "@yurupager/shared";
import { previewLaunchText } from "./i18n.js";

export interface PreviewTab {
  target: string;
  window: Window;
}

export function openPreviewTab(previewName: string): PreviewTab | null {
  const target = `yurupager-preview-${randomTargetSuffix()}`;
  const popup = window.open("", target);
  if (popup === null) return null;

  try {
    popup.opener = null;
    renderPreviewTabStatus(popup, previewLaunchText.openingStatus, previewName);
  } catch {
    // A browser may make the newly opened context inaccessible earlier than expected.
  }
  return { target, window: popup };
}

export function submitPreviewLaunch(result: PreviewLaunchResult, target: string): void {
  const action = previewLaunchAction(result.gatewayOrigin);
  const form = document.createElement("form");
  form.method = "POST";
  form.action = action;
  form.target = target;
  form.hidden = true;

  const ticket = document.createElement("input");
  ticket.type = "hidden";
  ticket.name = "ticket";
  ticket.value = result.ticket;
  form.append(ticket);

  document.body.append(form);
  try {
    form.submit();
  } finally {
    form.remove();
  }
}

export function renderPreviewTabStatus(popup: Window, title: string, detail: string): void {
  const document = popup.document;
  document.title = title;
  const main = document.createElement("main");
  const heading = document.createElement("h1");
  const description = document.createElement("p");
  heading.textContent = title;
  description.textContent = detail;
  main.append(heading, description);
  document.body.replaceChildren(main);
  document.body.style.margin = "0";
  document.body.style.fontFamily = "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  document.body.style.color = "#202522";
  document.body.style.background = "#f7f9f7";
  main.style.maxWidth = "560px";
  main.style.margin = "18vh auto 0";
  main.style.padding = "24px";
  heading.style.fontSize = "20px";
  heading.style.letterSpacing = "0";
  description.style.overflowWrap = "anywhere";
  description.style.color = "#66706a";
}

export function previewLaunchAction(gatewayOrigin: string): string {
  const gateway = new URL(gatewayOrigin);
  if ((gateway.protocol !== "https:" && gateway.protocol !== "http:") || gateway.username !== "" || gateway.password !== "") {
    throw new Error("Invalid preview gateway origin");
  }
  return new URL("/__yurupager/open", `${gateway.origin}/`).toString();
}

function randomTargetSuffix(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint32Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(8, "0")).join("");
}
