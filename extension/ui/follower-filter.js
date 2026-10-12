// Inclusive bounds. Unknown counts remain visible only when no range is active.
export function matchesFollowerRange(count,{min=null,max=null}={}) {
  if(min===null&&max===null)return true;
  return Number.isSafeInteger(count)&&count>=0&&(min===null||count>=min)&&(max===null||count<=max);
}

// Equal visual space for each order of magnitude; the upper endpoint is unlimited.
const stops=[0,1000,10000,100000,1000000,10000000];
export function positionToCount(position) {
  const p=Math.max(0,Math.min(1000,Number(position)));
  const segment=Math.min(4,Math.floor(p/200));
  return Math.round(stops[segment]+(stops[segment+1]-stops[segment])*(p-segment*200)/200);
}
export function countToPosition(count) {
  if(count==null)return 1000;
  const n=Math.max(0,count),segment=stops.findIndex((stop,i)=>i<5&&n<=stops[i+1]);
  if(segment<0)return 1000;
  return (segment+(n-stops[segment])/(stops[segment+1]-stops[segment]))*200;
}
