import { NextResponse } from 'next/server';
import { fetchNflMonitor } from '../../../../lib/nfl-monitor.mjs';
import { collectPaperCandidates } from '../../../../lib/nfl-paper.mjs';
import {
 fetchNflScores,
 nflPaperDatabaseConfigured,
 syncNflPaperLedger,
} from '../../../../lib/nfl-paper-storage.js';
import { buildNflSetups } from '../../../../lib/nfl-setups.mjs';
import { saveNflSnapshot } from '../../../../lib/nfl-storage.js';
export const dynamic='force-dynamic';
export const maxDuration=50;
export async function GET(request){
 const token=process.env.NFL_MONITOR_SECRET;
 if(!token) return NextResponse.json({ok:false,error:'monitor_secret_not_configured'},{status:503});
 if(request.headers.get('authorization')!== 'Bearer '+token) return NextResponse.json({ok:false,error:'unauthorized'},{status:401});
 try{
  const databaseConfigured=nflPaperDatabaseConfigured();
  const [result,scoreResult]=await Promise.all([
   fetchNflMonitor({propAttempts:2}),
   databaseConfigured?fetchNflScores():Promise.resolve({ok:false,status:'database_disabled',scores:[]}),
  ]);
  const {snapshot,...publicResult}=result;
  let persistence={status:'disabled'};
  let paperTrading={status:databaseConfigured?'not_synced':'database_required',captured:0,settled:0};
  let diagnostics={databaseConfigured,providerOk:result.ok,linesCount:result.linesCount||0,gameCount:result.gameMarkets?.games?.length||0,playerPlays:result.playerSetups?.plays?.length||0,playerActionable:result.playerSetups?.actionablePlays||0,candidates:0,blockers:[]};
  if(!databaseConfigured)diagnostics.blockers.push('database_not_configured');
  if(!result.ok)diagnostics.blockers.push('provider_unavailable');
  if(result.ok&&snapshot&&databaseConfigured){
   try{
    const saved=await saveNflSnapshot(snapshot);
    persistence={status:'saved',id:String(saved.id),checkedAt:saved.checked_at};
   }catch{
    persistence={status:'failed'};
    publicResult.warnings=[...(publicResult.warnings||[]),'NFL snapshot persistence failed'];
   }
   try{
    const setups=buildNflSetups(result.gameMarkets?.games||[],{now:Date.parse(result.checkedAt)});
    const candidates=collectPaperCandidates({setups,playerSetups:result.playerSetups,checkedAt:result.checkedAt});
    diagnostics.candidates=candidates.length;
    diagnostics.byAccount=Object.fromEntries([...new Set(candidates.map(c=>c.accountKey))].map(key=>[key,candidates.filter(c=>c.accountKey===key).length]));
    if(!candidates.length)diagnostics.blockers.push('no_qualified_play_candidates');
    paperTrading=await syncNflPaperLedger({candidates,scores:scoreResult.scores||[],checkedAt:result.checkedAt});
    paperTrading.scoreStatus=scoreResult.status;
   }catch{
    paperTrading={status:'failed',captured:0,settled:0,scoreStatus:scoreResult.status};
    diagnostics.blockers.push('ledger_sync_failed');
    publicResult.warnings=[...(publicResult.warnings||[]),'NFL paper ledger sync failed'];
   }
  }
  return NextResponse.json({...publicResult,persistence,paperTrading,diagnostics},{status:result.ok?200:503,headers:{'Cache-Control':'no-store'}});
 }catch(error){return NextResponse.json({ok:false,status:'monitor_failed',checkedAt:new Date().toISOString(),error:error instanceof Error?error.message:'Unknown error'},{status:502});}
}
