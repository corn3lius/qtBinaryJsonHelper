/*
 -------------------------------------------------------------------------


 -------------------------------------------------------------------------
 Description:

 Qt Binary Json helper -
  - used to decode/encode to the binary json type to increase speed
    and reduce the size of the messages in the pipes.

 From QT source :

  This defines a binary data structure for Json data. The data structure is optimised for fast reading
  and minimum allocations. The whole data structure can be mmap'ed and used directly.

  In most cases the binary structure is not as space efficient as a utf8 encoded text representation, but
  much faster to access.

  The size requirements are:

  String:
    Latin1 data: 2 bytes header + string.length()
    Full Unicode: 4 bytes header + 2*(string.length())

  Values: 4 bytes + size of data (size can be 0 for some data)
    bool: 0 bytes
    double: 8 bytes (0 if integer with less than 27bits)
    string: see above
    array: size of array
    object: size of object
  Array: 12 bytes + 4*length + size of Value data
  Object: 12 bytes + 8*length + size of Key Strings + size of Value data

  For an example such as

    {                                           // object: 12 + 5*8                   = 52
         "firstName": "John",                   // key 12, value 8                    = 20
         "lastName" : "Smith",                  // key 12, value 8                    = 20
         "age"      : 25,                       // key 8, value 0                     = 8
         "address"  :                           // key 12, object below               = 140
         {                                      // object: 12 + 4*8
             "streetAddress": "21 2nd Street",  // key 16, value 16
             "city"         : "New York",       // key 8, value 12
             "state"        : "NY",             // key 8, value 4
             "postalCode"   : "10021"           // key 12, value 8
         },                                     // object total: 128
         "phoneNumber":                         // key: 16, value array below         = 172
         [                                      // array: 12 + 2*4 + values below: 156
             {                                  // object 12 + 2*8
               "type"  : "home",                // key 8, value 8
               "number": "212 555-1234"         // key 8, value 16
             },                                 // object total: 68
             {                                  // object 12 + 2*8
               "type"  : "fax",                 // key 8, value 8
               "number": "646 555-4567"         // key 8, value 16
             }                                  // object total: 68
         ]                                      // array total: 156
    }                                           // great total:                         412 bytes

    The uncompressed text file used roughly 500 bytes, so in this case we end up using about
    the same space as the text representation.

    Other measurements have shown a slightly bigger binary size than a compact text
    representation where all possible whitespace was stripped out.

 -------------------------------------------------------------------------
 */
'use strict';

var util= require("util");
try {
    var printf = require("printf");
}
catch(ex){
    console.log("No printf module");
    var printf = undefined;
}
function QtBin(buffer){
    //
    // IF NOT buffer return error ?

    var obj = {};
    var flag = new Buffer("qbjs"); // encoding BE "sjbq" ??
    //printInFours(buffer);
    this.buffer = new Buffer(buffer);
    this.encoding = buffer.slice(0,4).toString();
    /*
     enum Type {
     Null =  0x0,
     Bool = 0x1,
     Double = 0x2,
     String = 0x3,
     Array = 0x4,
     Object = 0x5,
     Undefined = 0x80
     }   */
    this.TYPES = {
        "Null"    : 0x0,
        "Bool"    : 0x1,
        "Double"  : 0x2,
        "String"  : 0x3,
        "Array"   : 0x4,
        "Object"  : 0x5,
        "undefined" :0x80
    };
    buffer = buffer.slice(4);
    var topEntry = this.readObject(buffer);
    buffer = topEntry.buffer;

    this.json = Object.assign({},topEntry.value);

};

QtBin.prototype.readObject = function(buf){
      /*
       union {
           uint _dummy;
           qle_bitfield<0, 1> is_object;
           qle_bitfield<1, 31> length;
       };
       */
    if( buf.length < 8 ){ return {"value": {}}; }
    var hdr = buf.readUInt32LE(0,4);
    var isObject = (hdr & 0x1) === 1 ;
    var length = (hdr >> 1);
    var size   = buf.readUInt32LE(4,8);
    //console.log(" Found Entry ", isObject, " And has ", length, " Elements -- bytes ", size );
    var outbuf = buf.slice(size);
    buf = buf.slice(8);
    var json = {};
    if( ! isObject ){
        json = []; //?
    }
    if( length === 0 ){
        var entry = this.readObject(buf.slice(0,size));
        json = Object.assign({}, entry.value );
    }
    for( var i = 0; i < length; i++ ){
        var value = this.readObjectValue(buf);
        json = Object.assign({},json,value.value);
        buf = value.buffer;
    }
    //console.log("Object read size. ? ", ( size - buf.length ) );
    return {"value": json ,"length":length, "buffer" : outbuf, "isObject" : isObject };
};

QtBin.prototype.readObjectValue = function(buf) {
    /*
     union {
         uint _dummy;
         qle_bitfield<0, 3> type;
         qle_bitfield<3, 1> latinOrIntValue;
         qle_bitfield<4, 1> latinKey;
         qle_bitfield<5, 27> value;
         qle_signedbitfield<5, 27> int_value;
     };
     */
    var header          = buf.readUInt32LE(0,4);
    var type            =  header       & 0x7;
    var latinOrIntValue = (header >> 3) & 0x1;
    var latinKey        = (header >> 4) & 0x1;
    var value           = (header >> 5) & 0x7FFFFFF;
    if( (value >> 26) === 1 ){ value = value - (1<<27); }
    var typeStr  = "undefined";
    var readReturns = {};
    var json = {};

    switch(type){
        case this.TYPES.Null :
            typeStr = "NULL";
            readReturns = this.readString(buf.slice(4));
            var key = readReturns.value;
            json[key] = null;
            break;
        case this.TYPES.Bool :
            typeStr = "bool";
            readReturns = this.readString(buf.slice(4),latinKey);
            var key = readReturns.value;
            json[key] = (value !== 0) ? true : false;
            break;
        case this.TYPES.Double :  // VAL_KEY
            readReturns = this.readString(buf.slice(4));
            var key = readReturns.value;
            if( latinOrIntValue === 1){
                typeStr = "Int";
                // TODO get larger ints... 64bit
            }
            else {
                typeStr = "Double *";

                value = readReturns.buffer.readDoubleLE(0);
                readReturns.buffer = readReturns.buffer.slice(8);
            }
            json[key] = value;

            break;
        case this.TYPES.String :
            typeStr = "String";
            readReturns = this.readString(buf.slice(4));
            var key = readReturns.value;
            readReturns = this.readString(readReturns.buffer);
            var val = readReturns.value;
            json[key] = val;
            break;
        case this.TYPES.Array :
            typeStr = "Array";
            //readReturns = this.readArray(buf.slice(4), value);
            readReturns = this.readString(buf.slice(4));
            var key = readReturns.value;
            readReturns = this.readArray(readReturns.buffer);
            json[key] = readReturns.value;
            break;
        case this.TYPES.Object :
            typeStr = "Object";
            readReturns = this.readString(buf.slice(4));
            var key = readReturns.value;
            var sizeBytes = readReturns.buffer.slice(0,4).readUInt32LE();
            //console.log("geting object for '" + key + "'");
            buf = readReturns.buffer.slice(sizeBytes); // fastForward next item
            readReturns = this.readObject(readReturns.buffer.slice(4,sizeBytes));
            readReturns.buffer = buf;
            json[key] = Object.assign({},readReturns.value);

            break;
        case this.TYPES.undefined:
        default :
            typeStr = "undefined";

    }
    //console.log("Found ", typeStr, " adding ", json);

    return {"value" : json, "buffer": readReturns.buffer };
};

QtBin.prototype.readString = function(buf){
    // CHECK !! Buffer.isBuffer(buf);

    var strlen = buf.slice(0,2).readUInt16LE();

    // round the size up to the next 4 byte boundary
    //inline int alignedSize(int size) { return (size + 3) & ~3; }
    var bufend = (2+ strlen);
    var alignedSize = (bufend + 3) & ~3;
    var str = buf.slice(2,bufend).toString();

    return {"value": str ,"buffer" : buf.slice(alignedSize) };
};

QtBin.prototype.readArray = function(buf){
    var arr = [];

    var bytes  = buf.readUInt32LE(0,4);
    var size   = buf.readUInt32LE(4,8);
    var count  = (size >> 1);
    var table  = buf.readUInt32LE(8,12);

    var arrayData = buf.slice(  0  ,table);
    var table     = buf.slice(table,bytes);
    buf = buf.slice(bytes); // queue up next object

    //printInFours(arrayData);
    //printInFours(table, 2);

    for( var i= 0; i < count; i++){
        var readVal = this.readArrayValue(arrayData, table );
        arr.push(readVal.value);
        table = readVal.table;
    }

    return { "value" : arr, "buffer" : buf };
};

QtBin.prototype.readArrayValue = function(data, table){
    var readReturns = {};
    //var offset = 4;

    var header          = table.readUInt32LE(0,4);
    var type            =  header       & 0x7;
    var latinOrIntValue = (header >> 3) & 0x1;
    var latinKey        = (header >> 4) & 0x1;
    var value           = (header >> 5) & 0x7FFFFFF;
    if( (value >> 26) === 1 ){ value = value - (1<<27); }
    switch( type ) {
    case this.TYPES.Null:
        readReturns.value = null;
        break;
    case this.TYPES.Bool:
        readReturns.value = (value !== 0) ? true : false;
        break;
    case this.TYPES.Double:
        if(latinOrIntValue === 1 ){
            readReturns["value"] = value;
        }
        else{
            readReturns["value"] = data.slice(value).readDoubleLE();
        }
        break;
    case this.TYPES.String:
        readReturns = this.readString(data.slice(value));
        break;
    case this.TYPES.Array:
        readReturns = this.readArray(data.slice(value));
        break;
    case this.TYPES.Object:
        //printInFours(data.slice(value,16));
        var offset = value + 4;
        var sizeBytes = data.slice(value,offset).readUInt32LE();
        //console.log( " Slice @ 16 value is ", value , " ? : ", sizeBytes );
        readReturns = this.readObject(data.slice(offset, offset + sizeBytes));
        break;
    }
    return {"value":readReturns.value, "table": table.slice(4) };
};

function printInFours(buf, radix){
    for( var i = 0; i < buf.length; i+=4 ){
        console.log(printBuffer(buf.slice(i,4+i), radix ));
    }
}
function printBuffer(buf, radix){
    var str = "";
    radix = radix || 10;
    var frmt = " %03d";
    if( radix < 10 ) frmt = " %08d";
    if( radix > 10 ) frmt = " %02c";
    for ( var i =0; i < buf.length; i++ ){
        try {
            str += printf(frmt, buf[i].toString(radix));
        } catch(exception){
            str += ((radix < 10) ? " -?-  " : ".?") + buf[i].toString(radix);
        }
    }
    return str;
}

if( require.main === module ) {
    console.log(" Run as main! ");
}
else{
    module.exports = QtBin;
}