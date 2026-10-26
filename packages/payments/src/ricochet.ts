/**
 * The parts of @stephanfeb/ricochet's RicochetClient the offline path uses,
 * so a caller can pass the real client or a stand-in.
 */

import type { RicochetClient } from '@stephanfeb/ricochet/core'

export type RicochetLike = Pick<RicochetClient, 'peerId' | 'getDocument' | 'retrievePage' | 'sendMessage' | 'claimMessage'>
