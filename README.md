# gyp.js
[![NPM version](https://badge.fury.io/js/gyp.js.svg)](http://badge.fury.io/js/gyp.js)

**Work-in-progress*/

A **feature-reduce** port of [GYP][0] to JavaScript (Node.js).

## Why?

* [GYP][0] is the only Python dependency of Node.js .
* Python scripts have some contribution barrier for Node.js collaborators
* No generators other than `ninja` are actually required

## Installation

```bash
npm install -g gyp.js
```

## Progress

Done:

* `gyp.input` - i.e. the "core" responsible for parsing `.gyp`/`.gypi` files,
  resolving conditions/variables, generating target build list
* `gyp.py` - parser/interpreter of reduced Python syntax

Kind-of working:

* `ninja` generator on Linux, OSX

TODO:

* Verify `ninja` on FreeBSD, other Unixes
* Windows support
* Standalone Node-less version with [duktape][1]
* More operators in reduced Python interpreter
* Tests!

## Reduced Python

[GYP][0] conditions are written in Python. This project has no intention of
support of full Python syntax/runtime, thus only a limited subset was selected:

* Variable names
* Strings
* Numbers
* Unary operators: `not`
* Binary operators: `in`, `not in`, etc
* One method: `.split()`

Turns out this set is what is minimally required to be able to build Node.js
itself.

## LICENSE

This software is licensed under the MIT License.

Copyright Fedor Indutny, 2016.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.

[0]: https://gyp.gsrc.io/
[1]: https://github.com/svaarala/duktape
