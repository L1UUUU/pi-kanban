import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNativeCheckReceipt } from '../src/runtime/native-check.ts';
const expected={requestId:'one',generation:'generation',args:['--version'],maxOutputBytes:100};
const receipt={type:'native.check-result',requestId:'one',generation:'generation',arguments:['--version'],pid:123,birth:'123456789',status:0,reason:'exited',exitCode:0,outputBase64:Buffer.from('v24.19.0').toString('base64')};
test('native receipt codec binds command identity, process birth, OS result and exact output',()=>{assert.equal(validateNativeCheckReceipt(receipt,expected).output,'v24.19.0');for(const patch of [{requestId:'other'},{generation:'other'},{arguments:['-e','wrong']},{pid:0},{birth:undefined},{status:5},{exitCode:null},{outputBase64:'!!!!'},{outputBase64:receipt.outputBase64+'\n'}])assert.throws(()=>validateNativeCheckReceipt({...receipt,...patch},expected),{code:'NATIVE_CHECK_INVALID'});assert.throws(()=>validateNativeCheckReceipt(receipt,{...expected,maxOutputBytes:3}),{code:'NATIVE_CHECK_INVALID'});});
test('native launch failure cannot masquerade as a successful check',()=>{const failure={...receipt,reason:'launch-failed',status:5,pid:0,exitCode:null,outputBase64:''};assert.equal(validateNativeCheckReceipt(failure,expected).reason,'launch-failed');assert.throws(()=>validateNativeCheckReceipt({...failure,status:0},expected),{code:'NATIVE_CHECK_INVALID'});});
test('native completion diagnostics remain raw evidence and do not upgrade a failed zero-exit check',()=>{
  for(const completion of [
    {waitStatus:0,exitConfirmed:true,censusStatus:0,baselinePids:[100],afterPids:[100,456],unexpectedPids:[456],baselineProcesses:{limit:8,imageCharacterLimit:512,omitted:0,processes:[{pid:100,openStatus:5}]},unexpectedProcesses:{limit:8,imageCharacterLimit:512,omitted:0,processes:[{pid:456,openStatus:0,imageStatus:0,imagePath:'C:\\Windows\\System32\\conhost.exe',timesStatus:0,birth:'123456789',exitTime:'123456999',waitStatus:0,waitError:0,exitCodeStatus:0,exitCode:0,membershipStatus:0,inJob:true}]},outputDrainTimedOut:false,outputDrainWaitMs:0,outputReadStatus:109},
    {waitStatus:0,exitConfirmed:true,censusStatus:0,baselinePids:[100],afterPids:[100],unexpectedPids:[],outputDrainTimedOut:true,outputDrainWaitMs:250,outputReadStatus:109},
  ]){
    const observed=validateNativeCheckReceipt({...receipt,reason:'descendants-survived',completion},expected);
    assert.equal(observed.exitCode,0);assert.equal(observed.reason,'descendants-survived');assert.deepEqual(observed.nativeEvidence.completion,completion);
  }
});
