import React, {createContext, useContext, useEffect, useRef, useState} from 'react';

export const MotionContext = createContext(false);

/** Local decorative films. The poster remains usable when autoplay, media or motion is unavailable. */
export default function MotionVideo({name, alpha=false, className='', active=true, hover=false, scrub=false, chapter}) {
  const paused=useContext(MotionContext);
  const container=useRef(null), video=useRef(null);
  const [near,setNear]=useState(name==='hero'), [visible,setVisible]=useState(false);
  const [hidden,setHidden]=useState(document.hidden), [ready,setReady]=useState(false);
  const [reduced,setReduced]=useState(()=>matchMedia('(prefers-reduced-motion: reduce)').matches);
  const base=`/assets/plankton-${name}`;
  const revision=['story-mainframe','story-archive'].includes(name)?'?v=2':'';
  useEffect(()=>{
    const reduce=matchMedia('(prefers-reduced-motion: reduce)');
    const onReduce=()=>setReduced(reduce.matches), onHide=()=>setHidden(document.hidden);
    const load=new IntersectionObserver(([e])=>{if(e.isIntersecting)setNear(true)},{rootMargin:'500px'});
    const view=new IntersectionObserver(([e])=>setVisible(e.isIntersecting),{threshold:.02});
    load.observe(container.current);view.observe(container.current);
    reduce.addEventListener('change',onReduce);document.addEventListener('visibilitychange',onHide);
    return()=>{load.disconnect();view.disconnect();reduce.removeEventListener('change',onReduce);document.removeEventListener('visibilitychange',onHide)};
  },[]);
  useEffect(()=>{
    const film=video.current;if(!film)return;
    if(visible&&active&&!paused&&!reduced&&!hidden&&!scrub) film.play().catch(()=>{});
    else film.pause();
  },[visible,active,paused,reduced,hidden,scrub,near,ready]);
  const isStill=paused||reduced||!ready;
  return <div ref={container} className={`motion-film ${className} ${isStill?'film-still':''}`} data-chapter={chapter} aria-hidden="true">
    <img src={`${base}-poster.${alpha?'png':'jpg'}${revision}`} alt="" className="film-poster" loading={name==='hero'?'eager':'lazy'}/>
    {near&&<video key={revision} ref={video} muted playsInline loop={!hover&&!scrub} preload={scrub?'auto':'metadata'} data-scroll-video={scrub?'true':undefined} onLoadedData={()=>setReady(true)} onEnded={hover?e=>{e.currentTarget.currentTime=0}:undefined}>
      {alpha&&<source src={`${base}-loop.webm${revision}`} type="video/webm"/>}
      <source src={`${base}-loop.mp4${revision}`} type="video/mp4"/>
    </video>}
  </div>;
}
