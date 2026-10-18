// Browser geometry regression for real Council components; synthetic paths, no art approval.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const portraitMode = true;
const root = process.env.COUNCIL_SOURCE_ROOT || process.cwd();
const output = process.env.COUNCIL_OUTPUT_DIR || path.join(process.cwd(), 'output/playwright');
mkdirSync(output, { recursive: true });
const result = await build({
  stdin: { contents: `import React from 'react';
import {createRoot} from 'react-dom/client';
import {CouncilShell} from './src/components/council/CouncilShell';
import {SAMPLE_ROOM_VIEW,fixtureMedallionSrcs} from './src/components/council/council-room-fixtures';
const portraits=Object.fromEntries(SAMPLE_ROOM_VIEW.seats.map(s=>[s.seatId, '/council/portraits/'+s.seatId+'-room.webp']));
window.mount=(mode)=>createRoot(document.getElementById('root')).render(<CouncilShell room={SAMPLE_ROOM_VIEW} medallionSrcBySeat={mode==='portrait'?portraits:mode==='mixed'?{...fixtureMedallionSrcs('/portraits').small,'simon-sinek':portraits['simon-sinek']}:fixtureMedallionSrcs('/portraits').small}/>);`,
    resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, loader: { '.css': 'empty' }, platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
});
const css=['council-theme.css','council-room.css'].map(f=>readFileSync(path.join(root,'src/components/council',f),'utf8')).join('\n');
const browser=await chromium.launch(process.env.COUNCIL_CHROME_PATH?{executablePath:process.env.COUNCIL_CHROME_PATH}:{});
const page=await browser.newPage();
const measurements=[];
try {
  for(const mode of portraitMode?['portrait','mixed','medallion']:['medallion']) {
    for(const width of [1000,320,390,640,768,967,968,1366,1920]) {
      await page.setViewportSize({width,height:1000});
      await page.setContent('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style><div id="root"></div>');
      await page.addStyleTag({content:css});
      await page.addScriptTag({content:result.outputFiles[0].text});
      await page.evaluate(mode=>window.mount(mode),mode);
      await page.locator('.council-room-seat').last().waitFor();
      const geometry=await page.evaluate(()=>{
        const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
        const frame=document.querySelector('.council-room-frame');
        return {viewport:innerWidth,pageWidth:document.documentElement.scrollWidth,frame:rect(frame),seats:[...document.querySelectorAll('.council-room-seat')].map(e=>({id:e.dataset.testid,...rect(e),position:getComputedStyle(e).position,name:e.querySelector('.council-seat-name').textContent,nameRect:rect(e.querySelector('.council-seat-name')),font:parseFloat(getComputedStyle(e.querySelector('.council-seat-name')).fontSize),portrait:e.dataset.hasPortrait==='true',image:rect(e.querySelector('img'))}))};
      });
      measurements.push({mode,...geometry});
      assert.equal(geometry.viewport,width);
      assert.equal(geometry.seats.length,9);
      assert.ok(geometry.frame.width<=920.1,`frame exceeds 920px: ${width} ${geometry.frame.width}`);
      if(!portraitMode)assert.ok(geometry.pageWidth<=width,`page overflow at ${width}`);
      for(const seat of geometry.seats){
        assert.ok(seat.font>=16,`small name: ${seat.name}`);
        assert.ok(seat.nameRect.x>=seat.x-1 && seat.nameRect.right<=seat.right+1 && seat.nameRect.bottom<=seat.bottom+1,`name clipped: ${seat.name}`);
        if(portraitMode && seat.portrait){assert.ok(Math.abs(seat.image.width-116)<.1);assert.ok(Math.abs(seat.image.height-145)<.1);}
        if(width>=968 && mode==='medallion')assert.equal(seat.position,'absolute');
      }
      for(let a=0;a<9;a++)for(let b=a+1;b<9;b++){
        const x=geometry.seats[a],y=geometry.seats[b];
        const dx=Math.min(x.right,y.right)-Math.max(x.x,y.x),dy=Math.min(x.bottom,y.bottom)-Math.max(x.y,y.y);
        assert.ok(dx<=.5||dy<=.5,`${mode} ${width}: ${x.name} overlaps ${y.name} by ${dx} x ${dy}`);
      }
      if([320,1000,1366].includes(width))await page.screenshot({path:path.join(output,`council-portrait-${mode}-${width}.png`),fullPage:true});
    }
  }
  console.log(`PASS ${measurements.length} real-browser layout cases; exact nine seats, names, bounds and desktop cap`);
} finally {
  writeFileSync(path.join(output,'council-portrait-geometry.json'),JSON.stringify(measurements,null,2)+'\n');
  await browser.close();
}
