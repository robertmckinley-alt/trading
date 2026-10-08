import { NextResponse } from 'next/server';
import { fetchNflMonitor } from '../../../../lib/nfl-monitor.mjs';
export const dynamic='force-dynamic';
export const maxDuration=30;
export async function GET(request){
 const token=process.env.NFL_MONITOR_SECRET;
 if(!token) return NextResponse.json({ok:false,error:'monitor_secret_not_configured'},{status:503});
 if(request.headers.get('authorization')!== 'Bearer '+token) return NextResponse.json({ok:false,error:'unauthorized'},{status:401});
 try{
  const result=await fetchNflMonitor();
  return NextResponse.json(result,{status:result.ok?200:503,headers:{'Cache-Control':'no-store'}});
 }catch(error){return NextResponse.json({ok:false,status:'monitor_failed',checkedAt:new Date().toISOString(),error:error instanceof Error?error.message:'Unknown error'},{status:502});}
}
