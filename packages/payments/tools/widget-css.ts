/** Writes the widget's stylesheet to dist/widget.css, for pages whose CSP refuses inline styles. */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { paymentWidgetCss } from '../src/widget.ts'

writeFileSync(fileURLToPath(new URL('../dist/widget.css', import.meta.url)), paymentWidgetCss.trimStart())
