import { NextResponse } from 'next/server';
import { fetchNflMonitor } from '../../../../lib/nfl-monitor.mjs';
import { saveNflSnapshot } from '../../../../lib/nfl-storage.js';
export const dynamic='force-dynamic';
export const maxDuration=50;
export async function GET(request){
 const token=process.env.NFL_MONITOR_SECRET;
 if(!token) return NextResponse.json({ok:false,error:'monitor_secret_not_configured'},{status:503});
 if(request.headers.get('authorization')!== 'Bearer '+token) return NextResponse.json({ok:false,error:'unauthorized'},{status:401});
 try{
  const result=await fetchNflMonitor({propAttempts:2});
  const {snapshot,...publicResult}=result;
  let persistence={status:'disabled'};
  const databaseConfigured=Boolean(process.env.NFL_DATABASE_URL||process.env.DATABASE_URL||process.env.POSTGRES_URL);
  if(result.ok&&snapshot&&databaseConfigured){
   try{
    const saved=await saveNflSnapshot(snapshot);
    persistence={status:'saved',id:String(saved.id),checkedAt:saved.checked_at};
   }catch{
    persistence={status:'failed'};
    publicResult.warnings=[...(publicResult.warnings||[]),'NFL snapshot persistence failed'];
   }
  }
  return NextResponse.json({...publicResult,persistence},{status:result.ok?200:503,headers:{'Cache-Control':'no-store'}});
 }catch(error){return NextResponse.json({ok:false,status:'monitor_failed',checkedAt:new Date().toISOString(),error:error instanceof Error?error.message:'Unknown error'},{status:502});}
}
