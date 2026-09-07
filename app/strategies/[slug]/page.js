import { notFound } from 'next/navigation';
import AppHeader from '../../../components/app-header';
import LiveStrategyBoard from '../../../components/live-strategy-board';
import { getStrategySnapshots } from '../../../lib/live-status.cjs';
import { STRATEGIES, getStrategyDefinition } from '../../../lib/strategy-registry.cjs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export function generateStaticParams() {
  return STRATEGIES
    .filter((strategy) => !['live-9am-sweep', 'hourly-sweep-ifvg-bos'].includes(strategy.slug))
    .map((strategy) => ({ slug: strategy.slug }));
}

export default async function ResearchStrategyPage({ params }) {
  const [{ slug }, liveStatus] = await Promise.all([params, getStrategySnapshots()]);
  const strategy = getStrategyDefinition(slug);
  if (!strategy) notFound();

  return (
    <main className="page-shell" id="main-content">
      <AppHeader section={`${strategy.paperAccountLabel} · strategy detail`} />

      <section className="strategy-detail-intro">
        <div>
          <span className="section-kicker">{strategy.paperAccountLabel} · paper only</span>
          <h1>{strategy.name}</h1>
          <p>{strategy.description}</p>
        </div>
        <dl className="strategy-research-facts">
          <div><dt>Stage</dt><dd>{strategy.researchStage}</dd></div>
          <div><dt>Evidence</dt><dd>{strategy.evidenceLabel}</dd></div>
          <div><dt>Activation</dt><dd>{strategy.activationTime}</dd></div>
          <div><dt>Risk family</dt><dd>{strategy.strategyFamilyName}</dd></div>
          <div><dt>License</dt><dd>{strategy.source.license}</dd></div>
        </dl>
      </section>

      <p className="research-disclaimer">
        This is an independent paper-trading experiment. Repository results have not been reproduced on this feed and do not predict future returns.
      </p>

      {strategy.source.url ? <p className="strategy-source-link"><a href={strategy.source.url} rel="noreferrer" target="_blank">Open research source →</a></p> : null}

      <LiveStrategyBoard initialData={liveStatus} />
    </main>
  );
}
