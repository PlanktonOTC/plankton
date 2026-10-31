import { useLayoutEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { CustomEase } from 'gsap/CustomEase';

gsap.registerPlugin(ScrollTrigger, CustomEase);

const CHAPTER_EASE = CustomEase.create(
  'planktonChapter',
  'M0,0 C0.202,0 0.253,1 0.5,1 0.672,1 0.819,0 1,0',
);
const clamp = gsap.utils.clamp(0, 1);

/**
 * Homepage motion contract (CSS geometry is in motion.css):
 * - .hero > .hero-stage; .hero-product contains .hero-film + .hero-terminal.
 * - .product-cards contains .overview-card links.
 * - .story contains one .story-art with .story-film[data-chapter] + .story-shade,
 *   followed by three .story-step elements (h2, .eyebrow and p).
 * - .arrival contains .arrival-art video; normal playback, never time-scrubbed.
 * - .studio-transition contains .studio-zoom-stage > .studio-wordmark;
 *   [data-zoom-center] identifies the letter; .studio-content follows the intro.
 * A bubbling plankton:chapter event is dispatched FROM .story, with a numeric
 * detail (0–2, or -1 outside the section). React owns video playback from it.
 * No pin spacers, global scroll handlers, or transforms on shared scene nodes.
 */
export function usePageMotion(rootRef, paused = false) {
  const introShown = useRef(false);
  const initialAnchorHandled = useRef(false);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let disposed = false;
    let refreshFrame = 0;
    let restoreInitialAnchor = false;
    let userInteracted = false;
    const originalMode = root.getAttribute('data-page-motion');
    const recordInteraction = () => { userInteracted = true; };
    const inputEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
    inputEvents.forEach(type => window.addEventListener(type, recordInteraction, { passive: true }));

    const refresh = (restoreAnchor = false) => {
      restoreInitialAnchor ||= restoreAnchor;
      cancelAnimationFrame(refreshFrame);
      refreshFrame = requestAnimationFrame(() => {
        if (disposed) return;
        ScrollTrigger.refresh();
        if (!restoreInitialAnchor || initialAnchorHandled.current) return;
        restoreInitialAnchor = false;
        initialAnchorHandled.current = true;
        if (userInteracted || !window.location.hash) return;
        try {
          const anchor = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
          if (!anchor || !root.contains(anchor)) return;
          // Font loading changes the long sticky sections' measurements. Restore
          // an initial deep link once, without smooth-scroll lag or later jumps.
          anchor.scrollIntoView({ block: 'start', behavior: 'instant' });
          ScrollTrigger.update();
        } catch { /* A malformed hash must not prevent normal navigation. */ }
      });
    };

    const media = gsap.matchMedia();
    const context = gsap.context(() => {
      media.add({
        always: 'all',
        desktop: '(min-width: 1024px)',
        heroDesktop: '(min-width: 1291px)',
        reduced: '(prefers-reduced-motion: reduce)',
      }, ({ conditions }) => {
        const { desktop, heroDesktop, reduced } = conditions;
        const still = paused || reduced;
        const cleanups = [];
        let branchDisposed = false;
        let firstChapterFrame = 0;
        const find = selector => root.querySelector(selector);
        const all = selector => Array.from(root.querySelectorAll(selector));
        const hero = find('.hero');
        const story = find('.story');
        const films = all('.story-film[data-chapter]');
        const shade = find('.story-shade');
        const steps = all('.story-step');
        const originalChapter = story?.getAttribute('data-active-chapter');
        const originalStoryStyles = [...films, shade].filter(Boolean)
          .map(node => [node, node.getAttribute('style')]);
        let chapter = -2;

        root.dataset.pageMotion = still ? 'static' : 'on';
        root.dataset.motionLayout = desktop ? 'desktop' : 'compact';

        const setChapter = (index, force = false) => {
          if (!story || (index === chapter && !force)) return;
          chapter = index;
          story.dataset.activeChapter = String(index);
          // Keep the last frame on stage when outside; React pauses the films.
          if (index >= 0) films.forEach((film, filmIndex) => {
            film.style.opacity = filmIndex === index ? '1' : '0';
            film.style.visibility = filmIndex === index ? 'visible' : 'hidden';
          });
          story.dispatchEvent(new CustomEvent('plankton:chapter', { detail: index, bubbles: true }));
        };
        const releaseStory = () => {
          setChapter(-1, true);
          originalStoryStyles.forEach(([node, style]) => {
            if (style === null) node.removeAttribute('style');
            else node.setAttribute('style', style);
          });
          if (story) {
            if (originalChapter == null) delete story.dataset.activeChapter;
            else story.dataset.activeChapter = originalChapter;
          }
        };

        if (still) {
          setChapter(-1, true);
          firstChapterFrame = requestAnimationFrame(() => setChapter(-1, true));
          refresh();
          return () => {
            branchDisposed = true;
            cancelAnimationFrame(firstChapterFrame);
            releaseStory();
          };
        }

        // Hero: the film and actual HTML terminal share a composition. The
        // product wrapper moves independently of the terminal's 3D transform.
        if (hero) {
          const product = hero.querySelector('.hero-product');
          const film = hero.querySelector('.hero-film');
          const terminal = hero.querySelector('.hero-terminal');
          const title = hero.querySelector('.hero-copy h1');
          const description = Array.from(hero.querySelectorAll('.hero-copy p, .hero-link'));
          const cue = hero.querySelector('.scroll-down');

          if (heroDesktop) {
            let seekVideo = () => {};
            let heroProgress = 0;
            const timeline = gsap.timeline({
              scrollTrigger: {
                trigger: hero, start: 'top top', end: 'bottom bottom', scrub: true,
                invalidateOnRefresh: true,
                onUpdate: self => { heroProgress = self.progress; seekVideo(self.progress); },
                onRefresh: self => { heroProgress = self.progress; seekVideo(self.progress); },
              },
            });
            // This full-duration tween fixes the .15–.55 crossfade interval.
            if (product) timeline.to(product, { yPercent: -6, ease: 'none', duration: 1 }, 0);
            else timeline.to({}, { duration: 1 }, 0);
            if (film) timeline.fromTo(film, { autoAlpha: 1 }, { autoAlpha: 0, ease: 'none', duration: .4 }, .15);
            if (terminal) timeline.fromTo(terminal,
              { autoAlpha: 0, rotationX: 19, rotationY: -5, rotationZ: -3 },
              { autoAlpha: 1, rotationX: 0, rotationY: 0, rotationZ: 0, ease: 'none', duration: .4 }, .15);
            if (description.length) timeline.fromTo(description,
              { y: 80, autoAlpha: 0 }, { y: 0, autoAlpha: 1, ease: 'none', duration: .9, stagger: .1 }, 0);
            if (cue) gsap.fromTo(cue, { autoAlpha: 1, y: 0 }, {
              autoAlpha: 0, y: -10, ease: 'none',
              scrollTrigger: { trigger: hero, start: 'top top', end: 'top+=250px top', scrub: true },
            });

            // Media may be mounted lazily by MotionVideo. One rAF and one
            // in-flight seek at a time avoids a queue of obsolete decoder work.
            let boundVideo = null;
            let seekFrame = 0;
            let wantedTime = 0;
            let unbindVideo = () => {};
            const bindVideo = () => {
              const video = hero.querySelector('video[data-scroll-video], .hero-film video');
              if (!video || video === boundVideo) return;
              unbindVideo();
              boundVideo = video;
              const seek = () => {
                seekFrame = 0;
                if (branchDisposed || document.hidden || video.readyState < 1 || video.seeking) return;
                if (Math.abs(video.currentTime - wantedTime) < .035) return;
                try { video.currentTime = wantedTime; } catch { /* Metadata can be replaced mid-load. */ }
              };
              const queueSeek = () => {
                if (!seekFrame && !branchDisposed) seekFrame = requestAnimationFrame(seek);
              };
              seekVideo = progress => {
                if (!Number.isFinite(video.duration) || video.duration <= 0) return;
                wantedTime = clamp(progress) * Math.max(0, Math.min(5.9, video.duration - .05));
                queueSeek();
              };
              const ready = () => { video.pause(); seekVideo(heroProgress); };
              const failed = () => { hero.dataset.heroMedia = 'failed'; };
              video.pause();
              video.addEventListener('loadedmetadata', ready);
              video.addEventListener('loadeddata', ready);
              video.addEventListener('seeked', queueSeek);
              video.addEventListener('error', failed);
              document.addEventListener('visibilitychange', queueSeek);
              ready();
              unbindVideo = () => {
                cancelAnimationFrame(seekFrame);
                seekFrame = 0;
                video.removeEventListener('loadedmetadata', ready);
                video.removeEventListener('loadeddata', ready);
                video.removeEventListener('seeked', queueSeek);
                video.removeEventListener('error', failed);
                document.removeEventListener('visibilitychange', queueSeek);
                video.pause();
              };
            };
            bindVideo();
            const observer = new MutationObserver(bindVideo);
            observer.observe(hero, { childList: true, subtree: true });
            cleanups.push(() => { observer.disconnect(); unbindVideo(); delete hero.dataset.heroMedia; });
          } else {
            if (film) gsap.set(film, { autoAlpha: 0 });
            if (terminal) gsap.set(terminal, { autoAlpha: 1, rotationX: 0, rotationY: 0, rotationZ: 0 });
          }

          // One entrance per mounted homepage; resizes and pause/resume do not
          // hide an already-read heading. Scroll owns the separate cue fade.
          const heroOnScreen = hero.getBoundingClientRect().bottom > 0 && window.scrollY < 80;
          if (!introShown.current && heroOnScreen) {
            introShown.current = true;
            const entrance = heroDesktop ? [title].filter(Boolean) : [title, ...description].filter(Boolean);
            gsap.fromTo(entrance, { y: 80, autoAlpha: 0 }, {
              y: 0, autoAlpha: 1, ease: heroDesktop ? 'power2.inOut' : 'power2.out',
              duration: heroDesktop ? 2 : 1, stagger: heroDesktop ? .25 : .1,
              delay: heroDesktop ? .35 : 0,
            });
          }
        }

        const cardsSection = find('.product-cards');
        const cards = all('.overview-card');
        if (cardsSection && cards.length) {
          gsap.fromTo(cards, { y: desktop ? 140 : 80, autoAlpha: 0 }, {
            y: 0, autoAlpha: 1, ease: 'power2.out', duration: 2, stagger: .25,
            scrollTrigger: {
              trigger: cardsSection, start: 'top bottom', end: 'bottom bottom',
              scrub: desktop, toggleActions: 'play none none none', invalidateOnRefresh: true,
            },
          });
          if (desktop) gsap.to(cardsSection, {
            autoAlpha: 0, ease: 'none',
            scrollTrigger: { trigger: cardsSection, start: 'bottom center', end: 'bottom top', scrub: true },
          });
          const storyStage = find('.story-art');
          if (desktop && storyStage) gsap.fromTo(storyStage, { autoAlpha: 0 }, {
            autoAlpha: 1, ease: 'none',
            // Match the cards' fade exactly. The source's opaque uniform-blue
            // overlap must become a composited fade over PLANKTON's fixed grid.
            scrollTrigger: { trigger: cardsSection, start: 'bottom center', end: 'bottom top', scrub: true },
          });
        }

        if (story && steps.length) {
          films.forEach((film, index) => {
            film.style.opacity = index === 0 ? '1' : '0';
            film.style.visibility = index === 0 ? 'visible' : 'hidden';
          });
          if (shade) shade.style.opacity = '0';
          let sectionActive = false;
          const applyStoryPosition = () => {
            if (branchDisposed) return;
            const rect = story.getBoundingClientRect();
            const viewport = window.innerHeight;
            sectionActive = rect.top < viewport && rect.bottom > 0;
            if (!sectionActive) { setChapter(-1); return; }
            if (!desktop) {
              // Compact text stays fully readable; switching still follows the
              // chapter crossing the viewport's center in either direction.
              let index = 0;
              steps.forEach((step, i) => { if (step.getBoundingClientRect().top <= viewport * .65) index = i; });
              setChapter(index);
              return;
            }
            let index = 0;
            let progress = 0;
            steps.forEach((step, i) => {
              const local = (viewport - step.getBoundingClientRect().top) / viewport;
              if (local >= 0) { index = i; progress = clamp(local); }
            });
            setChapter(index);
            const wave = Number(Math.sin(progress * Math.PI).toFixed(2));
            const opacity = index === steps.length - 1 && progress > .5 ? 0 : 1 - wave;
            if (films[index]) films[index].style.opacity = String(1-opacity);
          };
          ScrollTrigger.create({
            trigger: story, start: 'top bottom', end: 'bottom top',
            onEnter: applyStoryPosition, onEnterBack: applyStoryPosition,
            onUpdate: applyStoryPosition, onRefresh: applyStoryPosition,
            onLeave: () => setChapter(-1), onLeaveBack: () => setChapter(-1),
          });
          if (desktop) steps.forEach(step => {
            const heading = step.querySelector('h2');
            const eyebrow = step.querySelector('.eyebrow');
            const paragraph = step.querySelector('p');
            const titles = [heading, eyebrow].filter(Boolean);
            if (heading) gsap.fromTo(titles, { y: 20, autoAlpha: 0 }, {
              y: -20, autoAlpha: 1, ease: CHAPTER_EASE,
              scrollTrigger: {
                trigger: heading, start: 'top+=100px bottom', end: 'top top', scrub: true,
                invalidateOnRefresh: true,
              },
            });
            if (paragraph) gsap.fromTo(paragraph, { y: -20, autoAlpha: 0 }, {
              y: 20, autoAlpha: 1, ease: CHAPTER_EASE,
              scrollTrigger: {
                trigger: paragraph, start: 'top bottom', end: 'top center', scrub: true,
                invalidateOnRefresh: true,
              },
            });
          });
          // Story's React effect installs its listener after this layout effect.
          firstChapterFrame = requestAnimationFrame(() => {
            setChapter(sectionActive ? Math.max(0, chapter) : -1, true);
            applyStoryPosition();
          });
        }

        const arrival = find('.arrival');
        if (arrival) {
          let active = false;
          const syncPlayback = () => {
            arrival.querySelectorAll('.arrival-art video').forEach(video => {
              if (active && !document.hidden) video.play().catch(() => {});
              else video.pause();
            });
          };
          ScrollTrigger.create({
            trigger: arrival, start: 'top bottom', end: 'bottom top',
            onToggle: self => { active = self.isActive; syncPlayback(); },
            onRefresh: self => { active = self.isActive; syncPlayback(); },
          });
          const observer = new MutationObserver(syncPlayback);
          observer.observe(arrival, { childList: true, subtree: true });
          document.addEventListener('visibilitychange', syncPlayback);
          cleanups.push(() => {
            observer.disconnect();
            document.removeEventListener('visibilitychange', syncPlayback);
            active = false;
            syncPlayback();
          });

          const statement = find('.statement');
          const arrivalLayers = Array.from(arrival.querySelectorAll('.arrival-art, h2'));
          if (statement) {
            // User-directed continuous handoff: the image/title gently leave
            // while the next statement arrives through the same fixed grid.
            if (arrivalLayers.length) gsap.to(arrivalLayers, {
              y: -40, autoAlpha: 0, ease: 'none',
              scrollTrigger: {
                trigger: statement, start: 'top bottom', end: 'top 65%', scrub: true,
                invalidateOnRefresh: true,
              },
            });
            gsap.fromTo(statement, { y: 40, autoAlpha: 0 }, {
              y: 0, autoAlpha: 1, ease: 'none',
              scrollTrigger: {
                trigger: statement, start: 'top 90%', end: 'top 55%', scrub: true,
                invalidateOnRefresh: true,
              },
            });
          }
        }

        const studioIntro = find('.studio-transition');
        const studioContent = find('.studio-content');
        if (studioIntro && studioContent) {
          const brand=studioIntro.querySelector('.identity-brand');
          const tagline=studioIntro.querySelector('.identity-tagline');
          const chain=studioIntro.querySelector('.identity-chain');
          const sculpture=studioIntro.querySelector('.identity-sculpture');
          const note=studioIntro.querySelector('.identity-scroll-note');
          const progress={value:0};
          const emit=()=>{studioIntro.dataset.identityProgress=String(progress.value);studioIntro.dispatchEvent(new CustomEvent('plankton:identity',{detail:{progress:progress.value}}));};
          const identity=gsap.timeline({scrollTrigger:{trigger:studioIntro,start:'top top',end:()=>`+=${window.innerHeight*3}`,scrub:.3,invalidateOnRefresh:true}});
          identity.to(progress,{value:1,duration:3,ease:'none',onUpdate:emit},0);
          identity.fromTo(brand,{y:0,autoAlpha:1},{y:-55,autoAlpha:0,duration:.3,ease:'power1.inOut'},.55);
          identity.fromTo(tagline,{y:65,autoAlpha:0},{y:0,autoAlpha:1,duration:.3,ease:'power1.inOut'},.7);
          identity.to(tagline,{y:-55,autoAlpha:0,duration:.3,ease:'power1.inOut'},1.4);
          identity.fromTo(chain,{y:65,scale:1,autoAlpha:0},{y:0,autoAlpha:1,duration:.3,ease:'power1.inOut'},1.55);
          identity.to(chain,{scale:34,duration:.65,ease:'power2.in'},2.35);
          identity.to(chain,{autoAlpha:0,duration:.5,ease:'power2.out'},2.35);
          identity.fromTo(sculpture,{autoAlpha:.8,scale:.95},{autoAlpha:0,scale:1.3,duration:.65,ease:'power1.inOut'},2.35);
          if(note)identity.to(note,{autoAlpha:0,duration:.25},2.2);
          gsap.fromTo(studioContent,{opacity:0},{opacity:1,ease:'none',scrollTrigger:{trigger:studioIntro,start:'top -275%',end:'top -310%',scrub:true,invalidateOnRefresh:true}});
          gsap.fromTo(studioIntro.querySelector('.studio-zoom-stage'),{autoAlpha:0},{autoAlpha:1,ease:'none',scrollTrigger:{trigger:studioIntro,start:'top 75%',end:'top top',scrub:true}});
          cleanups.push(()=>delete studioIntro.dataset.identityProgress);
        }

        const studioOpening = find('.studio-opening');
        const studioPreview = find('.studio-preview');
        if (desktop && studioOpening && studioPreview) {
          // The user's final studio direction replaces decorative looping art
          // with the actual HTML dashboard arriving from the side and settling.
          // Measure its layout offset, not its transformed bounding rectangle.
          gsap.fromTo(studioPreview,
            { xPercent: -35, rotationX: 0, rotationY: 12, rotationZ: -8, scale: .88 },
            {
              xPercent: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1, ease: 'none',
              scrollTrigger: {
                trigger: studioOpening,
                start: () => `top+=${studioPreview.offsetTop} 90%`,
                end: () => `top+=${studioPreview.offsetTop} 25%`,
                scrub: true, invalidateOnRefresh: true,
              },
            });
        }

        refresh();
        return () => {
          branchDisposed = true;
          cancelAnimationFrame(firstChapterFrame);
          cleanups.forEach(cleanup => cleanup());
          releaseStory();
        };
      }, root);
    }, root);

    const fonts = document.fonts?.ready || Promise.resolve();
    fonts.then(() => { if (!disposed) refresh(true); });
    const onLoad = () => refresh();
    window.addEventListener('load', onLoad);

    return () => {
      disposed = true;
      cancelAnimationFrame(refreshFrame);
      window.removeEventListener('load', onLoad);
      inputEvents.forEach(type => window.removeEventListener(type, recordInteraction));
      media.revert();
      context.revert();
      if (originalMode === null) delete root.dataset.pageMotion;
      else root.setAttribute('data-page-motion', originalMode);
      delete root.dataset.motionLayout;
    };
  }, [rootRef, paused]);
}

export default usePageMotion;
