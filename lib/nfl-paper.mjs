// Research-only accounting. Does not submit orders or bets.
export const NFL_STRATEGIES = Object.freeze(['receiving-yards','receptions','rushing-yards','passing-yards','touchdowns','injury-driven','public-fade']);
export const INITIAL_BANKROLL = 50000;
export function americanToProbability(odds) {
 const o=Number(odds);
 if(!Number.isFinite(o)||o===0||Math.abs(o)<100)throw Error('Invalid American odds');
 return o>0?100/(o+100):-o/(-o+100);
}
export function decimalOdds(odds) {
 const o=Number(odds);
 if(!Number.isFinite(o)||o===0||Math.abs(o)<100)throw Error('Invalid American odds');
 return o>0?1+o/100:1+100/(-o);
}
export function removeTwoWayVig(over,under) {
 const a=americanToProbability(over),b=americanToProbability(under);
 return {over:a/(a+b),under:b/(a+b),overround:a+b};
}
export function expectedValue(probability,odds) {
 const p=Number(probability);
 if(!Number.isFinite(p)||p<0||p>1)throw Error('Probability must be 0..1');
 return p*(decimalOdds(odds)-1)-(1-p);
}
export function settlePaperPosition(position,result) {
 if(!['win','loss','push'].includes(result))throw Error('Invalid result');
 const stake=Number(position.stake);
 if(!Number.isFinite(stake)||stake<=0)throw Error('Invalid stake');
 return {...position,result,pnl:result==='push'?0:result==='loss'?-stake:stake*(decimalOdds(position.odds)-1)};
}
export function summarizePaperAccount(positions=[],startingBalance=INITIAL_BANKROLL) {
 let equity=startingBalance,peak=equity,maxDrawdown=0,wins=0,losses=0,pushes=0,staked=0;
 for(const p of positions) {
  if(!['win','loss','push'].includes(p.result))continue;
  const settled=settlePaperPosition(p,p.result);
  equity+=settled.pnl;staked+=Number(p.stake);
  if(p.result==='win')wins++;else if(p.result==='loss')losses++;else pushes++;
  peak=Math.max(peak,equity);
  maxDrawdown=Math.max(maxDrawdown,peak-equity);
 }
 return {startingBalance,equity,pnl:equity-startingBalance,roi:staked?(equity-startingBalance)/staked:0,wins,losses,pushes,maxDrawdown,positions:wins+losses+pushes};
}
export function createPaperAccounts() {
 return NFL_STRATEGIES.map(strategy=>({strategy,startingBalance:INITIAL_BANKROLL,positions:[],...summarizePaperAccount()}));
}
