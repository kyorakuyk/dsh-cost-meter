/**
 * Browser half of dsh-cost-meter (M3): a Settings → Cost section.
 *
 * The section registers into `settings.section` (the additive settings-page
 * seat) and fetches the host's overview route (`/cost-meter/api/overview`,
 * served by the host plugin's webServer registration) for its data. The host
 * does all folding/aggregation; this half is pure presentation.
 *
 * @module dsh-cost-meter/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings.section slot declaration into the SlotMap.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { CostPanel } from './CostPanel.tsx'

/** Required services: the slot registry. */
export const inject = ['slots']

/**
 * Mount the browser registrations.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'cost-meter',
    order: 90,
    label: '成本',
  }, CostPanel))
}
