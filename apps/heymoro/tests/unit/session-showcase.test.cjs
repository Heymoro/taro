const {test}=require('node:test')
const assert=require('node:assert/strict')
const {load}=require('../source.cjs')
const {template}=require('../fixtures/creation.cjs')
const mocks={'@tarojs/taro':{},'./auth':{getStoredSession:()=>null,getStoredToken:()=>null}}
const key='a'.repeat(32)
test('template contract consumes session share references, not standalone gallery uploads',()=>{
 const {readTemplate}=load('src/creation-contract.js',mocks)
 const value=template('effect');delete value.displayConfig.examples;value.displayConfig.showcaseShareKeys=[key]
 const dto=readTemplate({value});assert.deepEqual(Array.from(dto.displayConfig.showcaseShareKeys),[key]);assert.equal('examples' in dto.displayConfig,false)
})
test('public session contract projects only selected result identifiers, not private inputs',()=>{
 const {readSessionShare}=load('src/creation-contract.js',mocks)
 const dto=readSessionShare({value:{key,title:'合照',templateId:1,userId:99,prompt:'PRIVATE',images:[{id:12,width:1024,height:1024,createdAt:'2026-11-17T00:00:00.000Z',mediaId:15}]},key})
 assert.equal(dto.templateId,1);assert.equal('prompt' in dto,false);assert.equal('mediaId' in dto.images[0],false)
 assert.throws(()=>readSessionShare({value:{...dto,key:'bad'},key}))
})
