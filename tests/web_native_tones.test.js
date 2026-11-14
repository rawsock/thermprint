import test from 'node:test';
import assert from 'node:assert/strict';
import { nativePalette, nativeRowPalette, NATIVE_ROW_TONES } from '../site/native-tones.js';
import { grayscalePackets } from '../site/protocol.js';
import { preparePrint, drawInk, drawPreview } from '../site/raster.js';
import { createCanvas } from '@napi-rs/canvas';

function decoded(packets, row, x) {
  let value = 0;
  for (let bit=0;bit<8;bit++) if (packets[row*4+(bit>>1)][3+(bit%2)*48+(x>>3)] & (0x80>>(x%8))) value |= 1<<bit;
  return value;
}

test('every 2..256-tone palette interpolates monotone bounded heat and retains exact endpoints', () => {
  for (let levels=2;levels<=256;levels++) {
    const { doses, coverage } = nativePalette(levels);
    assert.equal(doses.length,levels);
    assert.equal(coverage.length,levels);
    assert.equal(doses[0],0); assert.equal(doses.at(-1),255);
    assert.equal(coverage[0],0); assert.equal(coverage.at(-1),1);
    for (let i=0;i<levels;i++) {
      assert.ok(Number.isInteger(doses[i]) && doses[i]>=0 && doses[i]<=255);
      assert.ok(coverage[i]>=0 && coverage[i]<=1);
      if (i) { assert.ok(doses[i]>=doses[i-1]); assert.ok(coverage[i]>=coverage[i-1]); }
    }
  }
  assert.deepEqual(nativePalette(4).doses,[0,85,170,255]);
  for (const bad of [0,1,2.5,257,NaN]) assert.throws(()=>nativePalette(bad),/Tone count/);
});

test('adaptive row palettes retain fractional brackets and the full small palette', () => {
  assert.deepEqual(nativeRowPalette(new Float32Array(384).fill(127.5),4),[0,1,2,3]);
  assert.deepEqual(nativeRowPalette(new Float32Array(384).fill(127.5),256),[0,127,128]);
  assert.deepEqual(nativeRowPalette(new Float32Array(384).fill(255),256),[0]);
  for (const levels of [12,16,31,128,256]) {
    const values=Float32Array.from({length:384},(_,x)=>x*255/383);
    const row=nativeRowPalette(values,levels);
    assert.equal(row[0],0); assert.equal(row.at(-1),levels-1);
    assert.ok(row.length<=NATIVE_ROW_TONES+1);
    assert.equal(new Set(row).size,row.length);
  }
});

test('adaptive gradients bound heater loads and preserve tone through diffusion', () => {
  const height=64;
  const rgba=Uint8ClampedArray.from({length:384*height*4},(_,i)=>i%4===3?255:Math.round((Math.floor(i/4)%384)*255/383));
  for (const method of ['stucki','atkinson']) for (const dither of [false,true]) {
    const job=preparePrint(rgba,height,{nativeGray:true,levels:256,feedScale:1,contrast:100,sharpen:false,method,dither});
    for (let y=0;y<job.height;y++) {
      const counts=new Map();
      for (const tone of job.ink.subarray(y*384,(y+1)*384)) if(tone) counts.set(tone,(counts.get(tone)||0)+1);
      assert.ok(counts.size<=NATIVE_ROW_TONES);
      assert.ok([...counts.values()].reduce((n,count)=>n+Math.ceil(count/64),0)<=15);
      assert.equal(job.ink[y*384],255); assert.equal(job.ink[(y+1)*384-1],0);
    }
    if (dither && method==='stucki') for(let x=16;x<368;x+=16) {
      let sum=0;
      for(let y=0;y<job.height;y++) for(let dx=0;dx<16;dx++) sum+=job.ink[y*384+x+dx]/255;
      assert.ok(Math.abs(sum/(job.height*16)-(1-(x+7.5)/383))<.02);
    }
  }
});

test('all256 native codes remain available across rows instead of a fixed ten-shade palette', () => {
  const rgba=Uint8ClampedArray.from({length:384*256*4},(_,i)=>i%4===3?255:255-Math.floor(i/(384*4)));
  const job=preparePrint(rgba,256,{nativeGray:true,levels:256,feedScale:1,dither:false,contrast:100,sharpen:false});
  assert.equal(new Set(job.artworkInk).size,256);
  for(let y=0;y<256;y++) assert.ok(job.artworkInk.subarray(y*384,(y+1)*384).every(tone=>tone===y));
});

test('calibrated image preparation, preview, export and wire doses share the same palette', () => {
  const height=8;
  const rgba=Uint8ClampedArray.from({length:384*height*4},(_,i)=>i%4===3?255:Math.floor(i/4)%256);
  for (const levels of [2,3,4,7,31,256]) {
    const job=preparePrint(rgba,height,{nativeGray:true,levels,feedScale:1,contrast:100,sharpen:false});
    const palette=nativePalette(levels), packets=grayscalePackets(job.ink,job.height,levels,true);
    for (let row=0;row<job.height;row++) for(let x=0;x<384;x++) {
      assert.equal(decoded(packets,row,x),palette.doses[job.ink[row*384+x]]);
    }
    const canvas=createCanvas(384,height);
    drawInk(canvas,job.artworkInk,height,levels,true);
    const rendered=canvas.getContext('2d').getImageData(0,0,384,height).data;
    for(let i=0;i<job.artworkInk.length;i++) assert.equal(rendered[i*4],Math.round(255*(1-palette.coverage[job.artworkInk[i]])));
    drawPreview(canvas,job.artworkInk,height,false,levels,true);
    assert.deepEqual(canvas.getContext('2d').getImageData(0,0,384,height).data,rendered);
  }
});
