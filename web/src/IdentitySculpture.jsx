import React,{useContext,useEffect,useRef,useState} from 'react';
import {MotionContext} from './MotionVideo';

// A local, transparent metal sculpture. Rendering is driven by scroll, never an idle loop.
export default function IdentitySculpture(){
  const host=useRef(null),paused=useContext(MotionContext),[ready,setReady]=useState(false);
  useEffect(()=>{
    const node=host.current, section=node.closest('.studio-transition');
    let alive=true,visible=false,started=false,frame=0,renderer,scene,camera,mesh,geometry,material,environment,pmrem,room;
    let current=Number(section.dataset.identityProgress||0),target=current;
    const reduced=matchMedia('(prefers-reduced-motion: reduce)');
    const draw=()=>{
      frame=0;if(!alive||!renderer||!visible||document.hidden)return;
      current=paused||reduced.matches?target:current+(target-current)*.085;
      mesh.rotation.set(.38+current*.2,-.55+current*.65,-.32+current*.2);
      const approach=Math.max(0,(current-.72)/.28);
      mesh.scale.setScalar(.84+approach*.65);
      camera.position.z=5.7-approach*.6;
      renderer.render(scene,camera);
      if(!paused&&!reduced.matches&&Math.abs(target-current)>.0002)frame=requestAnimationFrame(draw);
    };
    const request=()=>{if(!frame&&visible&&!document.hidden)frame=requestAnimationFrame(draw)};
    const resize=()=>{if(!renderer)return;const r=node.getBoundingClientRect();if(!r.width||!r.height)return;renderer.setSize(r.width,r.height,false);camera.aspect=r.width/r.height;camera.updateProjectionMatrix();request()};
    const update=e=>{target=Number(e.detail?.progress??section.dataset.identityProgress??0);if(!paused&&!reduced.matches)request()};
    const initialize=async()=>{
      if(started)return;started=true;
      try{
        const [THREE,{RoomEnvironment}]=await Promise.all([import('three'),import('three/addons/environments/RoomEnvironment.js')]);
        if(!alive)return;
        renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,powerPreference:'low-power'});
        renderer.setPixelRatio(Math.min(devicePixelRatio,innerWidth<700?1.25:1.5));
        renderer.setClearColor(0x000000,0);renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;
        renderer.domElement.setAttribute('aria-hidden','true');node.appendChild(renderer.domElement);
        scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(36,1,.1,100);camera.position.z=5.7;
        room=new RoomEnvironment();pmrem=new THREE.PMREMGenerator(renderer);environment=pmrem.fromScene(room,.045);scene.environment=environment.texture;
        geometry=new THREE.TorusKnotGeometry(1.03,.24,220,32,2,3);
        material=new THREE.MeshPhysicalMaterial({color:0x9da4aa,metalness:1,roughness:.16,clearcoat:.6,clearcoatRoughness:.1,envMapIntensity:1.35});
        mesh=new THREE.Mesh(geometry,material);mesh.position.set(.03,0,0);scene.add(mesh);
        const light=new THREE.DirectionalLight(0xffffff,3);light.position.set(-3,5,4);scene.add(light);
        const rim=new THREE.DirectionalLight(0xc8d5df,2);rim.position.set(3,-2,-3);scene.add(rim);
        resize();setReady(true);request();
      }catch{if(alive)setReady(false)}
    };
    const intersection=new IntersectionObserver(([e])=>{visible=e.isIntersecting;if(visible){initialize();request()}else{cancelAnimationFrame(frame);frame=0}},{rootMargin:'150px'});
    intersection.observe(node);
    const sizing=new ResizeObserver(resize);sizing.observe(node);
    section.addEventListener('plankton:identity',update);document.addEventListener('visibilitychange',request);reduced.addEventListener('change',request);
    return()=>{alive=false;cancelAnimationFrame(frame);intersection.disconnect();sizing.disconnect();section.removeEventListener('plankton:identity',update);document.removeEventListener('visibilitychange',request);reduced.removeEventListener('change',request);geometry?.dispose();material?.dispose();environment?.dispose();pmrem?.dispose();room?.dispose();renderer?.dispose();renderer?.domElement.remove()};
  },[paused]);
  return <div ref={host} className={`identity-sculpture ${ready?'is-ready':''}`} aria-hidden="true"><img className="identity-sculpture-fallback" src="/assets/plankton-logo.png" alt=""/></div>;
}
