import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { bootstrapAegis } from '../bootstrap.js';

/**
 * Aegis server scaffold. Routes for issue / settle / price-feed / pool stats
 * land in subsequent commits (A2e → A4). For now: healthz + static placeholder
 * + config introspection, so the deployed Render instance has something to
 * answer with while the rest of the rewrite is in progress.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, 'public');
const projectRoot = resolve(__dirname, '..', '..');

const aegis = bootstrapAegis();
const app = express();

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(express.static(publicDir, { maxAge: '5m', extensions: ['html'] }));

app.get('/LIMITATIONS.md', (_req, res) => {
  res.type('text/markdown').sendFile(resolve(projectRoot, 'LIMITATIONS.md'));
});

app.get('/api/config', (_req, res) => {
  res.json({
    network: aegis.cfg.HEDERA_NETWORK,
    mirrorNodeUrl: aegis.cfg.MIRROR_NODE_URL,
    topicId: aegis.cfg.AEGIS_TOPIC_ID,
    buyer: aegis.buyerAccountId,
    underwriter: aegis.underwriterAccountId,
    provider: aegis.providerAccountId,
    underwriterIsBuyer: aegis.underwriterIsBuyer,
    defaults: {
      r0UsdHr: aegis.cfg.DEFAULT_R0_USD_HR,
      maxExposureRatio: aegis.cfg.MAX_EXPOSURE_RATIO,
      payoutAutonomousCapHbar: aegis.cfg.PAYOUT_AUTONOMOUS_CAP_HBAR,
    },
  });
});

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    network: aegis.cfg.HEDERA_NETWORK,
    topicId: aegis.cfg.AEGIS_TOPIC_ID,
    buyer: aegis.buyerAccountId,
    underwriter: aegis.underwriterAccountId,
  });
});

app.use((err, _req, res, _next) => {
  console.error('[aegis]', err);
  res.status(500).json({ error: err?.message ?? 'internal error' });
});

const port = aegis.cfg.PORT;
app.listen(port, () => {
  console.log(`\nAegis listening on http://localhost:${port}`);
  console.log(`  network:     ${aegis.cfg.HEDERA_NETWORK}`);
  console.log(`  topic:       ${aegis.cfg.AEGIS_TOPIC_ID ?? '(unset — run npm run smoke:hcs)'}`);
  console.log(`  buyer:       ${aegis.buyerAccountId}`);
  console.log(`  underwriter: ${aegis.underwriterAccountId}${aegis.underwriterIsBuyer ? '  (same as buyer — single-account demo mode)' : ''}`);
});

process.on('SIGTERM', () => { aegis.close(); process.exit(0); });
process.on('SIGINT', () => { aegis.close(); process.exit(0); });
