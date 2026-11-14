import test from 'node:test';
import assert from 'node:assert/strict';
import { nativePalette } from '../site/native-tones.js';
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
  assert.deepEqual(nativePalette(4).doses,[0,22,131,255]);
  for (const bad of [0,1,2.5,257,NaN]) assert.throws(()=>nativePalette(bad),/Tone count/);
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
