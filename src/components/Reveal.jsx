import { useEffect, useRef, useState } from 'react'



export default function Reveal({ as: Tag = 'div', className = '', delay = 0, children, ...rest }) {

  const ref = useRef(null)

  const [inView, setInView] = useState(false)



  useEffect(() => {

    const el = ref.current

    if (!el) return

    const io = new IntersectionObserver(

      ([entry]) => {

        if (entry.isIntersecting) {

          setInView(true)

          io.disconnect()

        }

      },

      { threshold: 0.15 }

    )

    io.observe(el)

    return () => io.disconnect()

  }, [])



  return (

    <Tag

      ref={ref}

      className={`reveal ${inView ? 'in' : ''} ${className}`}

      style={{ transitionDelay: `${delay}ms` }}

      {...rest}

    >

      {children}

    </Tag>

  )

}
