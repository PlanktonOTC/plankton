import React, {lazy,Suspense} from 'react';
import {createRoot} from 'react-dom/client';
import './styles.css';
import './fonts.css';
import {I18nProvider,startingLanguage} from './i18n';
if (import.meta.env.DEV) document.title = 'LIVE preview';
const Page=lazy(()=>location.pathname.startsWith('/docs')?import('./Docs'):location.pathname.startsWith('/trade')?import('./Dashboard'):location.pathname.startsWith('/feed')?import('./Feed'):import('./App'));
// The language (and its dictionary) is settled before the first paint, so a Chinese visitor never sees English flash first.
startingLanguage().then(({lang,dict})=>createRoot(document.getElementById('root')).render(<I18nProvider initialLang={lang} initialDict={dict}><Suspense fallback={<div role="status" style={{minHeight:'100svh',display:'grid',placeItems:'center',fontSize:12,letterSpacing:'.12em'}}>PLANKTON</div>}><Page/></Suspense></I18nProvider>));
