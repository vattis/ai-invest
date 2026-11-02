import {randomUUID} from 'node:crypto';

export function initialState(){return {accounts:{kr:{A:{cash:10000000,positions:{}},B:{cash:10000000,positions:{}}},us:{A:{cash:10000,positions:{}},B:{cash:10000,positions:{}}}},quotes:{kr:{},us:{}},recent:{kr:[],us:[]},trades:[],processedJobs:[],processedFeedback:[],lessons:{kr:[],us:[]},daily:{kr:{},us:{}}};}
export function value(account,quotes){return account.cash+Object.entries(account.positions).reduce((n,[s,qty])=>n+qty*(quotes[s]?.price??0),0);}
export function view(account,quotes){return {cash:account.cash,positions:Object.entries(account.positions).filter(([,q])=>q>0).map(([symbol,quantity])=>({symbol,quantity,price:quotes[symbol]?.price??null})),equity:value(account,quotes)};}
function round(n,market){return Number(n.toFixed(market==='kr'?0:4));}
export function applyPair(state,market,jobId,pair,quotes,now=Date.now(),costs={}){
  if(state.processedJobs.includes(jobId))return [];
  if(!pair.A||!pair.B)return [];
  const expiry=Math.min(Date.parse(pair.A.expires_at),Date.parse(pair.B.expires_at));
  const after=Math.max(Date.parse(pair.A.completed_at),Date.parse(pair.B.completed_at));
  if(now>expiry){state.processedJobs.push(jobId);return [];}
  // Both cohorts use one later quote snapshot; no fill on the decision's input prices.
  const needed=new Set([...pair.A.decision.orders,...pair.B.decision.orders].filter(o=>o.action!=='HOLD').map(o=>o.symbol));
  if([...needed].some(symbol=>!quotes[symbol]||Date.parse(quotes[symbol].as_of)<=after||Date.parse(quotes[symbol].as_of)>expiry))return [];
  const feeRate=Number(costs.feeRate??0.0005),slippage=Number(costs.slippage??0.0005);
  if(!Number.isFinite(feeRate)||feeRate<0||feeRate>0.02||!Number.isFinite(slippage)||slippage<0||slippage>0.02)throw new Error('비용 설정이 잘못되었습니다.');
  const trades=[];
  for(const cohort of ['A','B']){
    const account=state.accounts[market][cohort],orders=pair[cohort].decision.orders;
    const equity=value(account,quotes);
    // Sell before buying, so cash constraint is the same for both cohorts.
    const goals=orders.filter(o=>o.action!=='HOLD').map(o=>({order:o,quote:quotes[o.symbol]}))
      .filter(x=>x.quote&&Date.parse(x.quote.as_of)>after&&Date.parse(x.quote.as_of)<=expiry);
    goals.sort((x,y)=>Number(x.order.action==='BUY')-Number(y.order.action==='BUY'));
    for(const {order,quote} of goals){
      const {symbol,action,target_weight}=order,held=account.positions[symbol]??0;
      const target=Math.floor(equity*Math.min(target_weight,0.2)/quote.price),delta=target-held;
      if((action==='BUY'&&delta<=0)||(action==='SELL'&&delta>=0))continue;
      const side=delta>0?'BUY':'SELL',reference=side==='BUY'?(quote.ask??quote.price):(quote.bid??quote.price);
      const fill=round(reference*(side==='BUY'?1+slippage:1-slippage),market);
      if(fill<=0)continue;
      let quantity=Math.abs(delta);
      if(side==='BUY')quantity=Math.min(quantity,Math.floor(account.cash/(fill*(1+feeRate))));
      else quantity=Math.min(quantity,held);
      if(quantity<=0)continue;
      const gross=round(fill*quantity,market),fee=round(gross*feeRate,market);
      account.cash=round(account.cash+(side==='SELL'?gross-fee:-(gross+fee)),market);
      account.positions[symbol]=held+(side==='BUY'?quantity:-quantity);
      const trade={id:randomUUID(),job_id:jobId,market,cohort,symbol,side,quantity,price:fill,fee,as_of:quote.as_of,source:quote.source,reason:order.reason};
      trades.push(trade);state.trades.push(trade);
    }
  }
  state.processedJobs.push(jobId);return trades;
}
