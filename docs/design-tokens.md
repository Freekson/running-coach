# Dark theme and design tokens

The app uses a dark theme from first paint. `src/app/globals.css` is the source of truth for colors. It sets `color-scheme: dark` and the page background on the root element, so routes and states inside the root layout inherit the same canvas. `global-error.tsx` replaces that layout and imports the stylesheet and shared fonts itself. Keep the 404 and error screens on the same tokens. Do not add a light default or duplicate palette values in components.

## Color roles

| Token                                                                | Purpose                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `--color-bg`                                                         | Page canvas (`#101417`)                                            |
| `--color-surface`, `--color-surface-raised`, `--color-surface-hover` | Cards, controls, and interactive surfaces                          |
| `--color-border`                                                     | Decorative dividers and card edges                                 |
| `--color-border-strong`                                              | Input and secondary button boundaries that must be distinguishable |
| `--color-text`, `--color-text-muted`                                 | Primary and supporting copy                                        |
| `--color-primary`, `--color-primary-hover`, `--color-primary-active` | Links, primary actions, and active accents                         |
| `--color-primary-foreground`                                         | Text and icons on a primary fill                                   |
| `--color-focus`                                                      | Keyboard focus outline                                             |
| `--color-success`, `--color-warning`, `--color-error`                | Status text and badges, accompanied by words or icons              |

Use the role that matches the element, rather than copying a hex value. Add a new semantic token to the root palette when a genuinely new role is needed.

## Typography

The root layout loads variable Manrope and Inter through `next/font/google` with `display: 'swap'`, Latin and Cyrillic subsets, and metric-adjusted system fallbacks. Next.js self-hosts the generated font files, so browsers do not contact a third-party font server. Ukrainian uses the Cyrillic subset; add `cyrillic-ext` only if content requires glyphs outside it. Keep to these two custom families in the MVP.

| Token                                                                                           | Use                                                         |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `--font-heading`                                                                                | Manrope for hero, page, and section headings                |
| `--font-body`                                                                                   | Inter for body copy, controls, navigation, labels, and data |
| `--font-mono`                                                                                   | System monospace for code samples only                      |
| `--type-size-hero`, `--type-size-page`, `--type-size-card`                                      | Display, page, and card headings                            |
| `--type-size-body`, `--type-size-body-large`                                                    | Standard and prominent paragraphs                           |
| `--type-size-label`, `--type-size-caption`                                                      | Navigation, labels, badges, and compact notes               |
| `--type-weight-regular`, `--type-weight-medium`, `--type-weight-semibold`, `--type-weight-bold` | Text emphasis without thin weights                          |
| `--type-leading-tight`, `--type-leading-body`, `--type-leading-compact`                         | Heading, paragraph, and compact line heights                |

Use the heading family for headings and the body family for UI text. Keep headings at semibold or bold, body text at regular or medium, and compact UI at medium or semibold. Use `.metric-value` or `font-variant-numeric: tabular-nums` for pace, distance, counters, and aligned columns; right-align comparable values when their labels are separate. Use the body font for units. Let long values wrap instead of clipping them.

Check English and Ukrainian copy in actual headings and controls, including `І`, `Ї`, `Є`, `Ґ`, apostrophes, en/em dashes, and values such as `1 234,56 км` and `12:34 /км`. Give Ukrainian content `lang="uk"`; add a CJK font or fallback plan before introducing Japanese UI. Review 320–375px widths and 200% zoom with realistic labels and metric values.

## Reusable patterns

- Primary action: `.button`; secondary action: `.button.button--secondary`. These work on buttons and links. Use the native `disabled` attribute on buttons. For a disabled link, remove its `href` and click handler as well as adding `aria-disabled="true"`.
- Text links use the global link colors. Navigation links use the header's navigation styling. Do not remove the global `:focus-visible` outline.
- Text inputs, textareas, and selects use `.field` with a visible label. `aria-invalid="true"` adds an error border; pair it with an error message, since color alone does not explain a problem.
- Cards use `.card`; badges use `.badge` with `.badge--success`, `.badge--warning`, or `.badge--error` when appropriate. Include status text so meaning does not depend on color.
- Use `--color-text-muted` for supporting copy and placeholders, never opacity on text. Keep `--color-border` for decorative edges; controls use `--color-border-strong` or the focus outline.

The base palette's contrast ratios on the page background are 16.79:1 for primary text, 8.15:1 for muted text, and 9.36:1 for the primary accent. On the card surface they are 14.47:1, 7.02:1, and 8.07:1 respectively. The strong border is 4.64:1 against a card surface. When adding colors or compositing overlays, check the resulting contrast against WCAG AA: 4.5:1 for normal text and 3:1 for non-text control boundaries and focus indicators.
