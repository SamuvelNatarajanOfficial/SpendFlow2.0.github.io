import 'fake-indexeddb/auto'
import { kdfPolicy } from '@/vault/crypto'

// TESTS ONLY: use a tiny PBKDF2 cost so the suite runs fast. Production code never touches these values;
// PRODUCTION_KDF_POLICY (frozen) is asserted separately in the crypto tests.
kdfPolicy.minIterations = 1000
kdfPolicy.acceptMin = 1000
