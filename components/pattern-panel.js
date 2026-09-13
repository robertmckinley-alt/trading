'use client';
import {useEffect,useState} from 'react';
const dollars=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(n);
export default function PatternPanel() {
  const [data,setData]=useState(null),[error,setError]=useState(''),[loaded,setLoaded]=useState(false);
  useEffect(()=>{let alive=true;const controller=new AbortController();
    async function refresh(){try{const r=await fetch('/api/backtest',{cache:'no-store',signal:controller.signal});const d=await r.json();if(!r.ok||d.ok===false)throw new Error(d.error||'Report unavailable');if(alive){setData(d.result?.patternMatching||null);setError(d.error||'');setLoaded(true);}}
    catch(e){if(alive){setError(e.message);setLoaded(true);}}}
    refresh();const timer=setInterval(refresh,60000);return()=>{alive=false;controller.abort();clearInterval(timer);};},[]);
  return <section className="research-section">
    <h2>Historical pattern comparison</h2>
    {error&&<p role="alert">{error}</p>}
    {!loaded&&<p role="status">Loading pattern report…</p>}
    {loaded&&!data&&<p>No pattern report yet. The VPS needs to build the model from its cached backtest and candle history. No performance estimate is available until that finishes.</p>}
    {data&&<><p>Updated {new Date(data.generatedAt).toLocaleString()} · {data.examples} usable historical examples · NQ report</p>
      <p>Needs 50 earlier trades and 20 close matches per strategy and direction. Outcomes must have closed at least 24 hours before the scored setup.</p>
      <div style={{overflowX:'auto'}}><table><thead><tr><th>Strategy</th><th>Scored / examples</th><th>All scored P&amp;L</th><th>Positive neighborhood</th><th>Negative neighborhood</th></tr></thead>
      <tbody>{data.strategies.map(s=><tr key={s.slug}><td>{s.name}<details><summary>Latest match evidence</summary><p>{s.latest?.status || 'No examples'} · {s.latest?.eligible ?? 0} eligible earlier trades</p>{s.latest?.status==='scored'&&<><p>Neighbor mean net R: {s.latest.expectancyR.toFixed(2)} · historical win rate: {(s.latest.winRate*100).toFixed(0)}%</p><p>This is not a calibrated probability of winning the next trade.</p><ol>{s.latest.neighbors.map(n=><li key={n.id}>{n.at.slice(0,10)}: {n.netR.toFixed(2)}R · distance {n.distance.toFixed(2)}</li>)}</ol></>}</details></td><td>{s.scored} / {s.examples}</td><td>{s.scored?dollars(s.baseline.netPnlUsd):'Insufficient evidence'}</td><td>{s.positive.trades} trades · {dollars(s.positive.netPnlUsd)}</td><td>{s.negative.trades} trades · {dollars(s.negative.netPnlUsd)}</td></tr>)}</tbody></table></div>
      <p>{data.methodology}</p><p>{data.cacheNote}</p><p>Different trade counts make total P&amp;L alone an incomplete comparison. These groups are diagnostic subsets of historical trades, not simulated portfolios with resized positions.</p>
    </>}
  </section>;
}
