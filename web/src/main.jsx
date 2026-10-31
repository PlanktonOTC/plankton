import React, {lazy,Suspense} from 'react';
import {createRoot} from 'react-dom/client';
import './styles.css';
import './fonts.css';
if (import.meta.env.DEV) document.title = 'LIVE preview';
const Page=lazy(()=>location.pathname.startsWith('/docs')?import('./Docs'):location.pathname.startsWith('/trade')?import('./Dashboard'):import('./App'));
createRoot(document.getElementById('root')).render(<Suspense fallback={<div role="status" style={{minHeight:'100svh',display:'grid',placeItems:'center',fontSize:12,letterSpacing:'.12em'}}>PLANKTON</div>}><Page/></Suspense>);
