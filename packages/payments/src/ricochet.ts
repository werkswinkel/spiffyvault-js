/**
 * The parts of @go-ricochet/ricochet's RicochetClient the offline path uses,
 * so a caller can pass the real client or a stand-in.
 */

import type { RicochetClient } from '@go-ricochet/ricochet/core'

export type RicochetLike = Pick<RicochetClient, 'peerId' | 'getDocument' | 'retrievePage' | 'sendMessage' | 'claimMessage'>
