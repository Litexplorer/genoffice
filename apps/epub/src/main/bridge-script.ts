/**
 * Script injected into every served XHTML chapter: applies the reader's font
 * size and theme, reports scroll progress, forwards link/image clicks to the
 * shell renderer (the chapter document is cross-origin to it), and turns the
 * scroll boundary into a page turn.
 *
 * Kept in its own module so the injected behaviour can be unit tested without
 * importing Electron.
 */
// XHTML is XML: the script body must be CDATA, or `&&` and `<` inside it abort
// the XML parse and Chromium renders its own error page instead of the chapter.
export const EPUB_BRIDGE_SCRIPT = `<script><![CDATA[(function(){
  var send=function(m){try{parent.postMessage(m,'*')}catch(e){}};
  var style=document.createElement('style');
  document.documentElement.appendChild(style);
  function apply(o){
    document.documentElement.style.fontSize=(o.fontSize||100)+'%';
    var bg='#fff',fg='#1c1c1c';
    if(o.theme==='dark'){bg='#1b1b1b';fg='#d8d8d8'}
    else if(o.theme==='sepia'){bg='#f4ecd8';fg='#3a2f22'}
    style.textContent='html{background:'+bg+' !important;}'+
      'body{background:'+bg+' !important;color:'+fg+' !important;'+
      'padding:28px 36px !important;box-sizing:border-box;}'+
      'img{max-width:100% !important;height:auto !important;}';
  }
  function maxScroll(){
    return Math.max(0,document.documentElement.scrollHeight-window.innerHeight);
  }
  function atEnd(){return window.scrollY>=maxScroll()-4}
  function atStart(){return window.scrollY<=4}
  function pageStep(){return Math.max(1,Math.round(window.innerHeight*0.9))}
  var LINE_STEP=48;
  window.addEventListener('message',function(e){
    var d=e.data||{};
    if(d.type==='epub-apply')apply(d);
    else if(d.type==='epub-scroll'){
      window.scrollTo(0,Math.round((d.ratio||0)*maxScroll()));
    }
    else if(d.type==='epub-nav'){
      var down=d.dir!=='prev';
      var step=d.unit==='page'?pageStep():LINE_STEP;
      if(down){
        if(atEnd())send({type:'epub-key',key:'next'});
        else window.scrollBy(0,step);
      } else {
        if(atStart())send({type:'epub-key',key:'prev'});
        else window.scrollBy(0,-step);
      }
    }
  });
  var last=0;
  window.addEventListener('scroll',function(){
    var now=Date.now();
    if(now-last<200)return;
    last=now;
    var h=Math.max(1,maxScroll());
    send({type:'epub-progress',ratio:Math.min(1,Math.max(0,window.scrollY/h))});
  },{passive:true});
  document.addEventListener('click',function(e){
    var t=e.target;
    if(!t)return;
    if(t.tagName==='IMG'){e.preventDefault();send({type:'epub-image',src:t.currentSrc||t.src});return}
    var a=t.closest?t.closest('a'):null;
    if(!a)return;
    var href=a.getAttribute('href')||'';
    if(!href)return;
    if(/^javascript:/i.test(href)){e.preventDefault();return}
    if(/^[a-z][a-z0-9+.-]*:/i.test(href)){a.target='_blank';a.rel='noopener';return}
    e.preventDefault();
    send({type:'epub-link',href:a.href});
  });
  var edgeArmed={start:true,end:true};
  window.addEventListener('wheel',function(e){
    if(e.deltaY>0&&atEnd()&&edgeArmed.end){
      edgeArmed.end=false;
      send({type:'epub-edge',edge:'end'});
    } else if(e.deltaY<0&&atStart()&&edgeArmed.start){
      edgeArmed.start=false;
      send({type:'epub-edge',edge:'start'});
    }
  },{passive:true});
  window.addEventListener('scroll',function(){
    if(!atEnd())edgeArmed.end=true;
    if(!atStart())edgeArmed.start=true;
  },{passive:true});
  function horizontal(){
    return document.documentElement.scrollWidth-window.innerWidth>4;
  }
  // Down/Up scroll the chapter first and only page once the boundary is
  // reached, so a reader can finish the last lines before the chapter turns;
  // Left/Right page immediately unless the chapter itself scrolls sideways.
  window.addEventListener('keydown',function(e){
    var k=e.key;
    if(k==='ArrowDown'||k==='PageDown'){
      if(atEnd()){e.preventDefault();send({type:'epub-key',key:'next'})}
      else if(k==='PageDown'){e.preventDefault();window.scrollBy(0,pageStep())}
    } else if(k==='ArrowUp'||k==='PageUp'){
      if(atStart()){e.preventDefault();send({type:'epub-key',key:'prev'})}
      else if(k==='PageUp'){e.preventDefault();window.scrollBy(0,-pageStep())}
    } else if(k==='ArrowRight'){
      if(!horizontal()||atEnd()){e.preventDefault();send({type:'epub-key',key:'next'})}
    } else if(k==='ArrowLeft'){
      if(!horizontal()||window.scrollX<=0){e.preventDefault();send({type:'epub-key',key:'prev'})}
    }
  });
  send({type:'epub-ready'});
})()]]></script>`

/** XHTML is XML: append before the closing body tag, or at the end when there is none. */
export function injectBridge(html: string): string {
  const close = html.lastIndexOf('</body>')
  if (close === -1) return html + EPUB_BRIDGE_SCRIPT
  return `${html.slice(0, close)}${EPUB_BRIDGE_SCRIPT}${html.slice(close)}`
}
