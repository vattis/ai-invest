const positive=x=>Number.isFinite(Number(x))&&Number(x)>0?Number(x):null;
export function marketTime(market,at=new Date()){
  const zone=market==='kr'?'Asia/Seoul':'America/New_York';
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',weekday:'short'}).formatToParts(at).map(x=>[x.type,x.value]));
  const minute=Number(p.hour)*60+Number(p.minute),open=market==='kr'?540:570,close=market==='kr'?930:960;
  return {day:`${p.year}-${p.month}-${p.day}`,open:p.weekday!=='Sat'&&p.weekday!=='Sun'&&minute>=open&&minute<close,closed:minute>=close,minute};
}
async function json(url,options={},fetcher=fetch){const res=await fetcher(url,{...options,signal:AbortSignal.timeout(12000)});if(!res.ok)throw new Error(`시세 공급자 HTTP ${res.status}`);return res.json();}
export function parseUs(trades,quotes,now=Date.now()){
  const result={};
  for(const [symbol,t] of Object.entries(trades?.trades??{})){
    const q=quotes?.quotes?.[symbol],timestamp=Date.parse(t.t),price=positive(t.p);
    if(!price||!Number.isFinite(timestamp)||timestamp>now+5000||now-timestamp>120000)continue;
    result[symbol]={symbol,price,bid:positive(q?.bp),ask:positive(q?.ap),as_of:new Date(timestamp).toISOString(),source:'alpaca_iex'};
    if(!Number.isFinite(Date.parse(q?.t))||Math.abs(Date.parse(q.t)-timestamp)>120000){result[symbol].bid=null;result[symbol].ask=null;}
  }
  return result;
}
export async function fetchUs(symbols,env=process.env,fetcher=fetch){
  if(!env.ALPACA_KEY_ID||!env.ALPACA_SECRET_KEY)throw new Error('ALPACA_KEY_ID/ALPACA_SECRET_KEY가 필요합니다.');
  const headers={'APCA-API-KEY-ID':env.ALPACA_KEY_ID,'APCA-API-SECRET-KEY':env.ALPACA_SECRET_KEY};
  const query=`?symbols=${encodeURIComponent(symbols.join(','))}&feed=iex`;
  const [trades,quotes]=await Promise.all([
    json(`https://data.alpaca.markets/v2/stocks/trades/latest${query}`,{headers},fetcher),
    json(`https://data.alpaca.markets/v2/stocks/quotes/latest${query}`,{headers},fetcher)
  ]);
  return parseUs(trades,quotes);
}
export function parseKr(symbol,body,now=new Date()){
  if(body?.rt_cd!=='0')throw new Error(`KIS 응답 오류 ${body?.msg_cd??'unknown'}`);
  const o=body.output??{},price=positive(o.stck_prpr),hhmmss=String(o.stck_cntg_hour??'').padStart(6,'0');
  if(!price||!/^[0-2][0-9][0-5][0-9][0-5][0-9]$/.test(hhmmss))return null;
  const {day}=marketTime('kr',now),time=new Date(`${day}T${hhmmss.slice(0,2)}:${hhmmss.slice(2,4)}:${hhmmss.slice(4)}+09:00`);
  if(!Number.isFinite(time.getTime())||time.getTime()>now.getTime()+5000||now-time>120000)return null;
  return {symbol,price,bid:null,ask:null,as_of:time.toISOString(),source:'kis_krx'};
}
export class KisClient{
  constructor(env=process.env,fetcher=fetch){this.env=env;this.fetcher=fetcher;this.token=null;this.expiry=0;}
  async auth(){
    if(!this.env.KIS_APP_KEY||!this.env.KIS_APP_SECRET)throw new Error('KIS_APP_KEY/KIS_APP_SECRET가 필요합니다.');
    if(this.token&&Date.now()<this.expiry)return this.token;
    const data=await json('https://openapi.koreainvestment.com:9443/oauth2/tokenP',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({grant_type:'client_credentials',appkey:this.env.KIS_APP_KEY,appsecret:this.env.KIS_APP_SECRET})},this.fetcher);
    if(!data.access_token)throw new Error('KIS 토큰 발급 실패');this.token=data.access_token;this.expiry=Date.now()+Math.min(Number(data.expires_in)||3600,3600)*1000-60000;return this.token;
  }
  async fetch(symbols){
    const token=await this.auth(),result={};
    for(const symbol of symbols){
      const url=new URL('https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price');
      url.searchParams.set('FID_COND_MRKT_DIV_CODE','J');url.searchParams.set('FID_INPUT_ISCD',symbol);
      const body=await json(url,{headers:{authorization:`Bearer ${token}`,appkey:this.env.KIS_APP_KEY,appsecret:this.env.KIS_APP_SECRET,tr_id:'FHKST01010100'}},this.fetcher);
      const quote=parseKr(symbol,body);if(quote)result[symbol]=quote;
      // KIS REST is per symbol. Keep calls below common per-second limits.
      if(symbol!==symbols.at(-1))await new Promise(r=>setTimeout(r,1100));
    }
    return result;
  }
}
