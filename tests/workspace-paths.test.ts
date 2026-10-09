import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalDirectory, canonicalDestination, sameDirectory, sameDestination, destinationsCollide } from '../src/workspace/paths.ts';

function directories(t:any){const root=mkdtempSync(join(tmpdir(),'pi-path-identity-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}

test('existing directory identity accepts normalized names and rejects different directories',t=>{
 const root=directories(t);const first=join(root,'First');const second=join(root,'Second');mkdirSync(first);mkdirSync(second);
 assert.equal(sameDirectory(first,join(first,'.')),true);assert.equal(sameDirectory(first,second),false);
 assert.equal(canonicalDirectory(first),realpathSync.native(first));assert.equal(sameDirectory(first,join(root,'missing')),false);
});
test('prospective destinations canonicalize only their checked existing parent',t=>{
 const root=directories(t);const prospective=join(root,'Missing','Child');const resolved=canonicalDestination(prospective);
 assert.equal(resolved,join(realpathSync.native(root),'Missing','Child'));assert.equal(existsSync(join(root,'Missing')),false);
 mkdirSync(join(root,'Missing'));mkdirSync(prospective);assert.equal(sameDestination(prospective,resolved),true);
});
test('directory identity never follows a symlink or Windows junction',t=>{
 const root=directories(t);const real=join(root,'real');mkdirSync(real);const link=join(root,'link');symlinkSync(real,link,process.platform==='win32'?'junction':'dir');
 assert.throws(()=>sameDirectory(real,link),/links and junctions/);assert.throws(()=>canonicalDestination(join(link,'new')),/links and junctions/);assert.throws(()=>destinationsCollide(real,link),/links and junctions/);
});
test('case-sensitive directories remain distinct physical objects',t=>{
 const root=directories(t);const upper=join(root,'Name');const lower=join(root,'name');mkdirSync(upper);
 if(existsSync(lower)){assert.equal(sameDirectory(upper,lower),true);t.diagnostic('This volume resolves case variants to the same directory.');}
 else {mkdirSync(lower);assert.equal(sameDirectory(upper,lower),false);assert.equal(destinationsCollide(upper,lower),false);}
});
test('Windows Git slash and drive-letter casing resolve to the same verified directory',{skip:process.platform!=='win32'},t=>{
 const root=directories(t);const directory=join(root,'MixedCaseWorktree');mkdirSync(directory);
 const gitStyle=directory.replaceAll('\\','/').replace(/^([A-Z]):/,(_,drive)=>`${drive.toLowerCase()}:`);
 assert.equal(sameDirectory(directory,gitStyle),true);assert.equal(canonicalDestination(directory),canonicalDestination(gitStyle));
 const alternateCase=directory.toUpperCase();assert.equal(sameDirectory(directory,alternateCase),true);
 const left=join(directory,'Pending');const right=join(gitStyle,'pending');assert.equal(destinationsCollide(left,right),true);
 assert.equal(dirname(canonicalDestination(left)),canonicalDirectory(directory));
});
