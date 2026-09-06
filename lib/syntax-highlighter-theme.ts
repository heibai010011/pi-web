import { vs, vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";

const PRE_SELECTOR = 'pre[class*="language-"]';

// SyntaxHighlighter merges this selector into the <pre> inline style before
// applying customStyle. The bundled light and dark themes use different forms
// of the same CSS property (backgroundColor vs. background), which React 19
// rejects when the theme changes during a rerender. The application supplies
// the code-block background through customStyle, so omit both theme defaults.
function withoutPreBackground(theme: typeof vs) {
  const preStyle = { ...theme[PRE_SELECTOR] };
  delete preStyle.background;
  delete preStyle.backgroundColor;

  return {
    ...theme,
    [PRE_SELECTOR]: preStyle,
  };
}

export const lightSyntaxTheme = withoutPreBackground(vs);
export const darkSyntaxTheme = withoutPreBackground(vscDarkPlus);
