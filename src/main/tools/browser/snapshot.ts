const REF_ATTR = "data-yobi-ref";

export interface SnapshotElement {
  ref: number;
  tag: string;
  role: string;
  name: string;
  text: string;
  value: string;
  placeholder: string;
  href: string;
  disabled: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  textPreview: string;
  elements: SnapshotElement[];
}

interface EvaluateResult {
  url: string;
  title: string;
  textPreview: string;
  elements: SnapshotElement[];
}

export async function collectPageSnapshot(page: any, maxElements = 120): Promise<PageSnapshot> {
  const result = (await page.evaluate(
    ({ refAttr, maxCount }: { refAttr: string; maxCount: number }): EvaluateResult => {
      const browser = globalThis as any;
      const documentAny = browser.document as any;
      const windowAny = browser.window as any;

      const normalize = (value: string | null | undefined, limit = 120): string => {
        if (!value) {
          return "";
        }

        return value
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, limit);
      };

      const isVisible = (element: any): boolean => {
        const rect = element.getBoundingClientRect();
        if (rect.width < 3 || rect.height < 3) {
          return false;
        }

        const style = windowAny.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
          return false;
        }

        return true;
      };

      const readRole = (element: any): string => {
        const role = normalize(element.getAttribute("role"));
        if (role) {
          return role;
        }

        return String(element.tagName || "").toLowerCase();
      };

      const candidateSelectors = [
        "a[href]",
        "button",
        "input",
        "textarea",
        "select",
        "summary",
        "[role='button']",
        "[role='link']",
        "[role='textbox']",
        "[role='combobox']",
        "[role='switch']",
        "[role='checkbox']",
        "[role='tab']",
        "[contenteditable='true']"
      ];

      for (const node of documentAny.querySelectorAll(`[${refAttr}]`)) {
        node.removeAttribute(refAttr);
      }

      const candidates = Array.from(documentAny.querySelectorAll(candidateSelectors.join(",")));
      const deduped: any[] = [];
      const seen = new Set<any>();
      for (const candidate of candidates) {
        if (seen.has(candidate)) {
          continue;
        }

        seen.add(candidate);
        deduped.push(candidate);
      }

      const elements: SnapshotElement[] = [];
      let ref = 1;

      for (const element of deduped) {
        if (!isVisible(element)) {
          continue;
        }

        if (elements.length >= maxCount) {
          break;
        }

        const tag = String(element.tagName || "").toLowerCase();
        const text = normalize(element.innerText || element.textContent, 160);
        const value = "value" in element ? normalize(String(element.value), 120) : "";
        const placeholder = "placeholder" in element
          ? normalize(String(element.placeholder), 80)
          : normalize(element.getAttribute("placeholder"), 80);
        const ariaLabel = normalize(element.getAttribute("aria-label"), 120);
        const alt = normalize(element.getAttribute("alt"), 120);
        const title = normalize(element.getAttribute("title"), 120);
        const name = ariaLabel || placeholder || text || value || alt || title;
        const href = normalize(element.getAttribute("href"), 200);
        const disabled =
          element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";

        element.setAttribute(refAttr, String(ref));

        elements.push({
          ref,
          tag,
          role: readRole(element),
          name,
          text,
          value,
          placeholder,
          href,
          disabled
        });

        ref += 1;
      }

      const bodyText = normalize(documentAny.body?.innerText, 900);

      return {
        url: windowAny.location.href,
        title: documentAny.title,
        textPreview: bodyText,
        elements
      };
    },
    {
      refAttr: REF_ATTR,
      maxCount: maxElements
    }
  )) as EvaluateResult;

  return {
    ...result,
    elements: result.elements
  };
}

export function refSelector(ref: number): string {
  return `[${REF_ATTR}="${ref}"]`;
}
